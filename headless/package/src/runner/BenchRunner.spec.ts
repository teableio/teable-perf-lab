import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ListTableRecordsQuery, ListTableRecordsResult } from '@teable/v2-core';
import { ok } from 'neverthrow';
import fixture from '../../fixtures/smoke.generator.json' with { type: 'json' };

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { computeCaseId, computeDatasetHash, type BenchCaseManifest } from '../case/manifest';
import type { LoadedCase } from '../case/types';
import { capturedEvidenceInput, declaredChecks, defaultEvidencePlan } from '../evidence/capture';
import { generateCases, type GeneratorSpec } from '../generator/generate';
import { createTeaBenchReportFromRun } from '../report/fromBenchRun';
import { readTeaArchive, writeTeaArchive } from '../tea/teaZip';

import {
  BENCH_MEASUREMENT_PROTOCOL,
  runCase,
  selectedValuesAreUnchanged,
  snapshotSelectedValuesByIds,
} from './BenchRunner';

const GENERATOR_SPEC = fixture as unknown as GeneratorSpec;

const writeManifestVariant = async (input: {
  base: { manifestPath: string; teaPath: string };
  dir: string;
  mutate: (manifest: BenchCaseManifest) => BenchCaseManifest;
  file: string;
}): Promise<{ manifestPath: string; teaPath: string }> => {
  const manifest = JSON.parse(await readFile(input.base.manifestPath, 'utf8')) as BenchCaseManifest;
  const mutated = input.mutate(manifest);
  const teaBytes = await readFile(input.base.teaPath);
  const schemaHash = sha256Hex(canonicalJson(readTeaArchive(teaBytes).structure));
  const datasetHash = computeDatasetHash({
    dataMode: mutated.source.dataMode,
    rows: mutated.dataset.rows,
    seed: mutated.dataset.seed,
    recipe: mutated.dataset.recipe,
  });
  const withCaseId: BenchCaseManifest = {
    ...mutated,
    caseId: computeCaseId({
      specVersion: 1,
      generatorVersion: mutated.generatorVersion,
      schemaHash,
      datasetHash,
      workload: mutated.workload,
      oracle: mutated.oracle,
    }),
    dataset: { ...mutated.dataset, dataHash: datasetHash },
  };
  const manifestPath = join(input.dir, input.file);
  await writeFile(manifestPath, `${JSON.stringify(withCaseId, null, 2)}\n`, 'utf8');
  return { manifestPath, teaPath: input.base.teaPath };
};

describe('runCase', () => {
  let baseCase: { manifestPath: string; teaPath: string };
  let selectCase: { manifestPath: string; teaPath: string };
  let baseManifest: BenchCaseManifest;
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'headless-bench-runner-'));
    const generated = await generateCases({ ...GENERATOR_SPEC, outDir: workDir });
    baseCase = generated.cases[0]!;
    baseManifest = JSON.parse(await readFile(baseCase.manifestPath, 'utf8')) as BenchCaseManifest;
    let generatedSelectCase: { manifestPath: string; teaPath: string } | undefined;
    for (const generatedCase of generated.cases) {
      const manifest = JSON.parse(
        await readFile(generatedCase.manifestPath, 'utf8')
      ) as BenchCaseManifest;
      if (manifest.dimensions?.motif === 'select-lookup-formula') {
        generatedSelectCase = generatedCase;
        break;
      }
    }
    if (!generatedSelectCase) throw new Error('Missing generated select-lookup-formula case');
    selectCase = generatedSelectCase;
  }, 180_000);

  it('measures query, update, and flush then passes the invariant oracle', async () => {
    const report = await runCase({
      teaPath: baseCase.teaPath,
      manifestPath: baseCase.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 1,
    });

    expect(report.operations.map((operation) => operation.key)).toEqual(
      baseManifest.workload.map((step) => step.key)
    );
    for (const operation of report.operations) {
      expect(operation.p95Ms).toBeGreaterThanOrEqual(0);
      expect(operation.samplesMs).toHaveLength(3);
      expect(operation.errors).toBe(0);
    }
    expect(report.oracle.status).toBe('pass');
    expect(report.verdict).toBe('pass');
    expect(report.repetitions[0]!.setup.totalRows).toBeGreaterThan(0);
    expect(report.specVersion).toBe(1);
    expect(report.generatorVersion).toBe(GENERATOR_SPEC.generatorVersion);
    expect(report.seed).toEqual(baseManifest.dataset.seed);
    expect(report.warmup).toBe(1);
    expect(report.samples).toBe(3);
    expect(report.environment.runtime).toMatch(/^(bun|node) /);
  }, 180_000);
  it('runs the complete workload during warmup and reports warmup failures', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'warmup-failing-step.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: manifest.workload.map((step) =>
          step.kind === 'write-update'
            ? { ...step, value: { kind: 'select-cycle' as const, choices: [] } }
            : step
        ),
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 1,
    });

    expect(report.measurementProtocol).toEqual(BENCH_MEASUREMENT_PROTOCOL);
    expect(report.verdict).toBe('fail');
    const warmupFailure = report.errors.find((error) => error.includes('#warmup-0:'));
    expect(warmupFailure).toContain('bench.workload.select_choices_empty');
    expect(report.errors.some((error) => error.includes('#sample-0:'))).toBe(true);
    const update = report.operations.find((operation) => operation.key === 'update-amount');
    expect(update).toMatchObject({ count: 0, errors: 1, rowsWritten: 0 });
    expect(update!.samplesMs).toEqual([]);
    expect(report.repetitions[0]!.phases.filter((phase) => phase.kind === 'warmup')).toHaveLength(
      1
    );
  }, 180_000);

  it('runs mutations and checkpoints on a fresh fixture per warmup pass without leaking receipts', async () => {
    const ordersRows = baseManifest.dataset.rows.Orders ?? 0;
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'warmup-drain.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'delete-all-orders',
            kind: 'write-delete',
            table: 'Orders',
            rows: ordersRows,
            batchSize: Math.min(100, Math.max(1, ordersRows)),
          },
          { key: 'flush-after-delete', kind: 'flush-computed' },
          {
            key: 'check-orders-empty',
            kind: 'checkpoint',
            check: {
              checkId: 'orders-empty',
              description: 'Every order was deleted before the checkpoint',
              obligationIds: ['obl-delete-all'],
              kind: 'row-count',
              table: 'Orders',
              expected: 0,
            },
          },
        ],
        oracle: [
          {
            key: 'invariants',
            kind: 'invariant',
            checks: [{ type: 'row-count', table: 'Orders', expected: 0 }],
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 2,
    });

    expect(report.errors).toEqual([]);
    expect(report.verdict).toBe('pass');
    const receipts = report.oracle.checks.filter((check) => check.checkId === 'orders-empty');
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ status: 'pass' });
    expect(
      report.operations.find((operation) => operation.key === 'delete-all-orders')
    ).toMatchObject({ count: 1, rowsWritten: ordersRows });
    expect(report.repetitions[0]!.phases.filter((phase) => phase.kind === 'warmup')).toHaveLength(
      1
    );
  }, 240_000);

  it('keeps warmup full-recompute references out of measured samples', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'warmup-reference-isolation.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        oracle: [
          {
            key: 'recompute-orders',
            checkId: 'recompute-orders',
            obligationIds: ['sample-state'],
            kind: 'full-recompute',
            tables: ['Orders'],
            reuse: 'identical-state',
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 2,
      warmup: 1,
    });

    const firstReference = report.oracle.checks.find(
      (check) => check.checkId === 'recompute-orders#sample-0'
    );
    const reusedReference = report.oracle.checks.find(
      (check) => check.checkId === 'recompute-orders#sample-1'
    );
    expect(firstReference?.method).toBe('fresh-runtime-full-recompute');
    expect(reusedReference?.method).toBe('verified-reference-state-comparison');
    expect(report.oracle.checks).toHaveLength(2);
    expect(report.errors).toEqual([]);
    expect(report.verdict).toBe('pass');
  }, 240_000);
  it('keeps oracle IDs unique across repetitions and matches the default evidence plan', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'repetition-evidence.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        oracle: [
          ...manifest.oracle.map((oracle) =>
            oracle.kind === 'invariant'
              ? {
                  ...oracle,
                  checks: oracle.checks.map((check) => ({
                    ...check,
                    obligationIds: ['sample-state'],
                  })),
                }
              : oracle
          ),
          {
            key: 'repetition-recompute',
            checkId: 'repetition-recompute',
            obligationIds: ['sample-state'],
            kind: 'full-recompute',
            tables: ['Orders'],
            reuse: 'identical-state',
          },
        ],
      }),
    });
    const manifest = JSON.parse(await readFile(variant.manifestPath, 'utf8')) as BenchCaseManifest;
    const report = await runCase({
      ...variant,
      backendOverride: 'pglite',
      samples: 2,
      warmup: 0,
      repetitions: 2,
    });
    const ids = report.oracle.checks.map((check) => check.checkId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('invariants/1/row-count#repetition-0/sample-0');
    expect(ids).toContain('invariants/1/row-count#repetition-1/sample-1');
    expect([...ids].sort()).toEqual(
      declaredChecks(manifest, 2, 2)
        .map((check) => check.checkId)
        .sort()
    );
    const plan = defaultEvidencePlan(manifest, 2, 2);
    expect(plan.suiteReceipts[0]!.rules.receipts[0]!.requiredCheckIds?.toSorted()).toEqual(
      [...ids].sort()
    );
    const hash = '0'.repeat(64);
    const canonical = createTeaBenchReportFromRun(
      report,
      capturedEvidenceInput({
        run: report,
        manifest,
        plan,
        captured: {
          dirty: false,
          sourceHash: hash,
          fixtureHash: hash,
          manifestHash: hash,
          host: { os: 'test', arch: 'test', cpu: 'test', logicalCpuCount: 1, memoryBytes: 0 },
        },
      })
    );
    expect(canonical.executions[0]!.correctness.map((check) => check.checkId).sort()).toEqual(
      [...ids].sort()
    );
    expect(canonical.catalogue.suiteReceipts[0]!.rules.receipts[0]).toMatchObject({
      executed: true,
      status: 'pass',
    });
    expect(report.repetitions).toHaveLength(2);
    const recomputes = report.oracle.checks.filter((check) => check.key === 'repetition-recompute');
    expect(
      recomputes
        .filter((check) => check.method === 'fresh-runtime-full-recompute')
        .map((check) => check.checkId)
        .sort()
    ).toEqual([
      'repetition-recompute#repetition-0/sample-0',
      'repetition-recompute#repetition-1/sample-0',
    ]);
    expect(
      recomputes
        .filter((check) => check.method === 'verified-reference-state-comparison')
        .map((check) => check.details)
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          referenceCheckId: 'repetition-recompute#repetition-0/sample-0',
        }),
        expect.objectContaining({
          referenceCheckId: 'repetition-recompute#repetition-1/sample-0',
        }),
      ])
    );
  }, 240_000);

  it('records weak percentile evidence without downgrading correctness', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'low-samples.manifest.json',
      mutate: (manifest) => manifest,
    });
    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 2,
      warmup: 0,
    });

    expect(report.warnings).toContain('bench.workload.percentile_evidence_low');
    expect(report.oracle.status).toBe('pass');
    expect(report.verdict).toBe('pass');
    expect(report.performanceVerdict).toBe('inconclusive');
  }, 180_000);

  it('evaluates a declared standalone p95 SLO without treating correctness as performance', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'slo.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        budgets: { sloP95Ms: 0, sloSource: 'test strict latency objective' },
      }),
    });
    const low = await runCase({ ...variant, backendOverride: 'pglite', samples: 2, warmup: 0 });
    expect(low.oracle.status).toBe('pass');
    expect(low.performanceVerdict).toBe('inconclusive');
    const resolved = await runCase({
      ...variant,
      backendOverride: 'pglite',
      samples: 20,
      warmup: 0,
    });
    expect(resolved.oracle.status).toBe('pass');
    expect(resolved.performanceVerdict).toBe('fail');
    for (const operation of resolved.operations) {
      expect(operation.warnings).toContain('bench.workload.p99_evidence_low');
      expect(operation.warnings).toContain('bench.metrics.p99_unresolved:min_samples=100');
      expect(operation.warnings).not.toContain('bench.workload.p95_evidence_low');
    }
  }, 300_000);

  it('wraps row selection and warns when a write needs more rows than exist', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'wrapped.manifest.json',
      mutate: (manifest) => {
        const update = manifest.workload.find((step) => step.kind === 'write-update')!;
        const available = manifest.dataset.rows[update.table] ?? 0;
        return {
          ...manifest,
          workload: manifest.workload.map((candidate) =>
            candidate.key === update.key
              ? { ...update, rows: available + 5, batchSize: 5 }
              : candidate
          ),
        };
      },
    });
    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 0,
    });

    expect(report.warnings).toContain('bench.workload.rows_wrapped');
    expect(report.verdict).toBe('pass');
  }, 180_000);

  it('marks the run failed and records the error when a step throws', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'failing.manifest.json',
      mutate: (manifest) => {
        const update = manifest.workload.find((step) => step.kind === 'write-update')!;
        return {
          ...manifest,
          workload: manifest.workload.map((candidate) =>
            candidate.key === update.key
              ? { ...update, value: { kind: 'select-cycle', choices: [] } }
              : candidate
          ),
        };
      },
    });
    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 0,
    });

    expect(report.verdict).toBe('fail');
    expect(report.errors.length).toBeGreaterThan(0);
    expect(report.errors[0]).toContain('bench.workload.select_choices_empty');
    const failed = report.operations.find((operation) => operation.key === 'update-amount');
    expect(failed).toBeDefined();
    expect(failed!.count).toBe(0);
    expect(failed!.errors).toBe(3);
    expect(failed!.samplesMs).toEqual([]);
    expect(failed!.p95Ms).toBeNull();
    expect(failed!.meanMs).toBeNull();
    expect(report.repetitions[0]!.verdict).toBe('fail');
    expect(report.repetitions[0]!.operations.map((operation) => operation.key)).toContain(
      'update-amount'
    );
    expect(report.environment.computationMode).toBe('hybrid-inline-and-flush');
    expect(report.warnings).toContain('bench.computation.hybrid_inline_and_flush');
  }, 180_000);

  it('creates linked rows and reports cumulative row counts across create steps', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'create-links.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        run: { ...manifest.run, samples: 3 },
        workload: [
          manifest.workload.find((step) => step.kind === 'query-core')!,
          {
            key: 'create-first',
            kind: 'write-create',
            table: 'Orders',
            rows: 2,
            batchSize: 1,
            typecast: false,
          },
          {
            key: 'create-second',
            kind: 'write-create',
            table: 'Orders',
            rows: 2,
            batchSize: 3,
            typecast: false,
          },
          { key: 'flush', kind: 'flush-computed' },
        ],
        oracle: [
          {
            key: 'invariants',
            kind: 'invariant',
            checks: [
              { type: 'row-count', table: 'Customers', expected: 1 },
              { type: 'row-count', table: 'Orders', expected: 14 },
              { type: 'unique-primary', table: 'Orders' },
              { type: 'link-count', table: 'Orders', field: 'Customer', expected: 14 },
              {
                type: 'computed-not-null',
                table: 'Orders',
                fields: ['Tax', 'TaxLabel'],
              },
            ],
          },
        ],
      }),
    });
    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 0,
    });

    expect(report.verdict).toBe('pass');
    expect(report.operations.map((operation) => operation.key)).toEqual([
      'list-orders',
      'create-first',
      'create-second',
      'flush',
    ]);
    for (const operation of report.operations.filter((entry) => entry.kind === 'write-create')) {
      expect(operation.samplesMs).toHaveLength(3);
      expect(operation.rowsWritten).toBe(6);
      expect(operation.errors).toBe(0);
    }
    expect(
      report.repetitions[0]!.phases.filter((phase) => phase.kind === 'sample-setup')
    ).toHaveLength(3);
    expect(report.oracle.status).toBe('pass');
  }, 240_000);

  it('deletes distinct remaining rows and keeps final counts consistent', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'delete.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        run: { ...manifest.run, samples: 3 },
        workload: [
          {
            key: 'create-orders',
            kind: 'write-create',
            table: 'Orders',
            rows: 4,
            batchSize: 2,
            typecast: false,
          },
          {
            key: 'delete-orders',
            kind: 'write-delete',
            table: 'Orders',
            rows: 2,
            batchSize: 1,
          },
          { key: 'flush', kind: 'flush-computed' },
        ],
        oracle: [
          {
            key: 'invariants',
            kind: 'invariant',
            checks: [
              { type: 'row-count', table: 'Orders', expected: 12 },
              { type: 'unique-primary', table: 'Orders' },
              { type: 'link-count', table: 'Orders', field: 'Customer', expected: 12 },
            ],
          },
        ],
      }),
    });
    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 0,
    });

    expect(report.verdict).toBe('pass');
    const deleteOperation = report.operations.find(
      (operation) => operation.key === 'delete-orders'
    );
    expect(deleteOperation?.rowsWritten).toBe(6);
    expect(deleteOperation?.warnings).not.toContain('bench.workload.rows_wrapped');
    expect(report.oracle.status).toBe('pass');
    expect(
      report.repetitions[0]!.oracle.checks.filter((check) => check.method === 'exact-row-count')
    ).toHaveLength(3);
  }, 240_000);

  it('rejects an impossible delete plan before timed mutations', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'impossible-delete.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        run: { ...manifest.run, samples: 3 },
        workload: [
          {
            key: 'delete-orders',
            kind: 'write-delete',
            table: 'Orders',
            rows: 11,
            batchSize: 5,
          },
          { key: 'flush', kind: 'flush-computed' },
        ],
        oracle: manifest.oracle,
      }),
    });

    await expect(
      runCase({
        teaPath: variant.teaPath,
        manifestPath: variant.manifestPath,
        backendOverride: 'pglite',
        samples: 3,
        warmup: 0,
      })
    ).rejects.toMatchObject({ code: 'bench.workload.delete_rows_exhausted' });
  }, 240_000);

  it('allows sample overrides because each sample starts from the same fixture state', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'samples-override.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'create-orders',
            kind: 'write-create',
            table: 'Orders',
            rows: 2,
            batchSize: 2,
            typecast: false,
          },
          { key: 'flush', kind: 'flush-computed' },
        ],
        oracle: [
          {
            key: 'rows',
            kind: 'invariant',
            checks: [{ type: 'row-count', table: 'Orders', expected: 12 }],
          },
        ],
      }),
    });
    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 2,
      warmup: 0,
    });
    expect(report.operations.find((operation) => operation.key === 'create-orders')).toMatchObject({
      count: 2,
      rowsWritten: 4,
    });
    expect(report.oracle.checks.filter((check) => check.method === 'exact-row-count')).toHaveLength(
      2
    );
  }, 240_000);

  it('asserts clear and restore values at their workload positions', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-clear-restore.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        dataset: {
          ...manifest.dataset,
          recipe: {
            ...manifest.dataset.recipe,
            tables: {
              ...manifest.dataset.recipe?.tables,
              Orders: {
                fields: {
                  ...manifest.dataset.recipe?.tables.Orders?.fields,
                  Amount: { distribution: 'constant', min: 5, max: 5 },
                },
              },
            },
          },
        },
        workload: [
          {
            key: 'check-initial',
            kind: 'checkpoint',
            check: {
              checkId: 'amount-initial',
              description: 'Every sample starts with the same input values',
              obligationIds: ['obl-initial'],
              kind: 'field-values',
              table: 'Orders',
              field: 'Amount',
              expected: Array.from({ length: 10 }, () => 5),
            },
          },
          {
            key: 'clear-amount',
            kind: 'write-update',
            table: 'Orders',
            field: 'Amount',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'literal', value: null },
          },
          { key: 'flush-cleared', kind: 'flush-computed' },
          {
            key: 'check-cleared',
            kind: 'checkpoint',
            check: {
              checkId: 'amount-cleared',
              description: 'Amount is empty after the clear',
              obligationIds: ['obl-clear'],
              kind: 'field-values',
              table: 'Orders',
              field: 'Amount',
              expected: Array.from({ length: 10 }, () => null),
            },
          },
          {
            key: 'restore-amount',
            kind: 'write-update',
            table: 'Orders',
            field: 'Amount',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'literal', value: 7 },
          },
          { key: 'flush-restored', kind: 'flush-computed' },
          {
            key: 'check-restored',
            kind: 'checkpoint',
            check: {
              checkId: 'amount-restored',
              description: 'Amount is the restored value',
              obligationIds: ['obl-restore'],
              kind: 'field-values',
              table: 'Orders',
              field: 'Amount',
              expected: Array.from({ length: 10 }, () => 7),
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 1,
    });

    expect(report.operations.map((operation) => operation.key)).toEqual([
      'clear-amount',
      'flush-cleared',
      'restore-amount',
      'flush-restored',
    ]);
    const checkpoints = report.oracle.checks.filter((check) => check.checkId.startsWith('amount-'));
    expect(checkpoints).toHaveLength(9);
    expect(checkpoints.every((check) => check.status === 'pass')).toBe(true);
    expect(report.verdict).toBe('pass');
    const initialChecks = checkpoints.filter((check) => check.checkId.startsWith('amount-initial'));
    expect(initialChecks.map((check) => check.checkId)).toEqual([
      'amount-initial#sample-0',
      'amount-initial#sample-1',
      'amount-initial#sample-2',
    ]);
    for (const check of initialChecks) {
      expect(check.expected).toEqual(Array.from({ length: 10 }, () => 5));
      expect(check.actual).toEqual(Array.from({ length: 10 }, () => 5));
      expect(check.status).toBe('pass');
    }
    const restoredChecks = checkpoints.filter((check) =>
      check.checkId.startsWith('amount-restored')
    );
    expect(restoredChecks).toHaveLength(3);
    for (const check of restoredChecks) {
      expect(check.expected).toEqual(Array.from({ length: 10 }, () => 7));
      expect(check.actual).toEqual(Array.from({ length: 10 }, () => 7));
      expect(check.status).toBe('pass');
    }
    const finalChecks = report.oracle.checks.filter(
      (check) => !check.checkId.startsWith('amount-')
    );
    for (const first of finalChecks.filter((check) => check.checkId.endsWith('#sample-0'))) {
      const baseId = first.checkId.slice(0, -'#sample-0'.length);
      for (const sample of [0, 1, 2]) {
        const check = finalChecks.find(
          (candidate) => candidate.checkId === `${baseId}#sample-${sample}`
        );
        expect(check).toBeDefined();
        expect(check!.expected).toEqual(first.expected);
        expect(check!.actual).toEqual(first.actual);
        expect(check!.status).toBe('pass');
      }
    }
    const phases = report.repetitions[0]!.phases;
    expect(phases[0]?.kind).toBe('warmup');
    expect(
      phases.filter((phase) => phase.kind === 'sample-setup').map((phase) => phase.sampleIndex)
    ).toEqual([0, 1, 2]);
    expect(phases.filter((phase) => phase.kind === 'warmup')).toHaveLength(1);
  }, 240_000);

  it('links an order to a customer and verifies the recompute at that position', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-link-membership.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'clear-links',
            kind: 'write-update',
            table: 'Orders',
            field: 'Customer',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'link-targets', table: 'Customers', indices: [] },
          },
          { key: 'flush-empty', kind: 'flush-computed' },
          {
            key: 'check-zero',
            kind: 'checkpoint',
            check: {
              checkId: 'links-zero',
              description: 'No order keeps a customer',
              obligationIds: ['obl-link-zero'],
              kind: 'full-recompute',
              tables: ['Orders'],
              reuse: 'identical-state',
            },
          },
          {
            key: 'link-one',
            kind: 'write-update',
            table: 'Orders',
            field: 'Customer',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'link-targets', table: 'Customers', indices: [0] },
          },
          { key: 'flush-one', kind: 'flush-computed' },
          {
            key: 'check-one',
            kind: 'checkpoint',
            check: {
              checkId: 'links-one',
              description: 'Every order links to the first customer',
              obligationIds: ['obl-link-one'],
              kind: 'full-recompute',
              tables: ['Orders'],
              reuse: 'identical-state',
            },
          },
          {
            key: 'remove-last',
            kind: 'write-update',
            table: 'Orders',
            field: 'Customer',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'link-targets', table: 'Customers', indices: [] },
          },
          { key: 'flush-removed', kind: 'flush-computed' },
          {
            key: 'check-removed',
            kind: 'checkpoint',
            check: {
              checkId: 'links-removed',
              description: 'Removing the last target clears every order',
              obligationIds: ['obl-link-remove-last'],
              kind: 'full-recompute',
              tables: ['Orders'],
              reuse: 'identical-state',
            },
          },
        ],
        oracle: [
          {
            key: 'row-counts',
            kind: 'invariant',
            checks: [{ type: 'row-count', table: 'Orders', expected: 10 }],
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 1,
    });

    const checkpoints = report.oracle.checks.filter((check) => check.key.startsWith('check-'));
    expect(checkpoints.map((check) => check.checkId).sort()).toEqual([
      'links-one#sample-0',
      'links-one#sample-1',
      'links-one#sample-2',
      'links-removed#sample-0',
      'links-removed#sample-1',
      'links-removed#sample-2',
      'links-zero#sample-0',
      'links-zero#sample-1',
      'links-zero#sample-2',
    ]);
    expect(checkpoints.every((check) => check.status === 'pass')).toBe(true);
    expect(
      checkpoints.filter((check) => check.method === 'fresh-runtime-full-recompute')
    ).toHaveLength(3);
    const reused = checkpoints.filter(
      (check) => check.method === 'verified-reference-state-comparison'
    );
    expect(reused).toHaveLength(6);
    for (const check of reused) {
      expect(check.details).toMatchObject({
        referenceCheckId: expect.stringMatching(/#sample-0$/),
        comparedSourceRows: expect.any(Number),
      });
      expect(check.details).not.toHaveProperty('copiedRows');
      expect(check.details).not.toHaveProperty('state');
      expect(check.details).not.toHaveProperty('source');
      expect(check.details).not.toHaveProperty('target');
    }
    expect(report.verdict).toBe('pass');
  }, 300_000);

  it('records an expected domain error only when the code matches and the values survive', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-expect-error.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'reject-bad-number',
            kind: 'expect-error',
            checkId: 'reject-bad-number',
            description: 'A strict number rejects a text value',
            obligationIds: ['obl-typecast-invalid'],
            expectedCode: 'validation.field.invalid_value',
            unchanged: { table: 'Orders', field: 'Amount', selection: 'first', rows: 1 },
            step: {
              kind: 'write-update',
              table: 'Orders',
              field: 'Amount',
              rows: 1,
              batchSize: 1,
              typecast: false,
              value: { kind: 'literal', value: 'not-a-number' },
            },
          },
          { key: 'flush', kind: 'flush-computed' },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 0,
    });

    const receipt = report.oracle.checks.find(
      (check) => check.checkId === 'reject-bad-number#sample-0'
    );
    expect(receipt).toMatchObject({
      status: 'pass',
      method: 'expected-domain-error-and-unchanged-state',
      expected: { code: 'validation.field.invalid_value' },
    });
    const rejected = report.operations.find((operation) => operation.key === 'reject-bad-number');
    expect(rejected).toMatchObject({ kind: 'expect-error', errors: 0, rowsWritten: 0, count: 3 });
    expect(
      rejected?.samplesMs.every((duration) => Number.isFinite(duration) && duration >= 0)
    ).toBe(true);
    expect(report.verdict).toBe('pass');
  }, 240_000);

  it('fails an expected error when an earlier batch changed the selected row', async () => {
    const variant = await writeManifestVariant({
      base: selectCase,
      dir: workDir,
      file: 'checkpoint-expect-error-changed.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        dataset: {
          ...manifest.dataset,
          recipe: {
            ...manifest.dataset.recipe,
            tables: {
              ...manifest.dataset.recipe?.tables,
              Customers: {
                ...manifest.dataset.recipe?.tables.Customers,
                fields: {
                  ...manifest.dataset.recipe?.tables.Customers?.fields,
                  Tier: { choices: ['A'] },
                },
              },
            },
          },
        },
        workload: [
          {
            key: 'reject-after-changing-row',
            kind: 'expect-error',
            checkId: 'reject-after-changing-row',
            expectedCode: 'validation.field.invalid_value',
            unchanged: { table: 'Customers', field: 'Tier', selection: 'first', rows: 1 },
            step: {
              kind: 'write-update',
              table: 'Customers',
              field: 'Tier',
              rows: 2,
              batchSize: 1,
              typecast: false,
              value: { kind: 'select-cycle', choices: ['B', 'missing-choice'] },
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    const receipt = report.oracle.checks.find(
      (check) => check.checkId === 'reject-after-changing-row'
    );
    expect(receipt).toMatchObject({
      status: 'fail',
      message: 'Expected error validation.field.invalid_value still changed the selected values',
    });
    expect(receipt?.actual).not.toEqual(receipt?.expected);
    expect(report.verdict).toBe('fail');
  }, 240_000);

  it('reads only selected ids in bounded chunks and detects a deleted selected row', async () => {
    const selectedRecordIds = Array.from(
      { length: 1001 },
      (_, index) => `rec${index.toString().padStart(16, '0')}`
    );
    const deletedRecordId = selectedRecordIds[500]!;
    const fieldId = `fld${'a'.repeat(16)}`;
    const execute = vi.fn(async (_context: unknown, query: ListTableRecordsQuery) => {
      const records = (query.selectedRecordIds ?? [])
        .filter((recordId) => recordId !== deletedRecordId)
        .map((recordId) => ({ id: recordId, fields: { [fieldId]: `value:${recordId}` } }));
      return ok({
        records,
        total: records.length,
        offset: 0,
        limit: query.selectedRecordIds?.length ?? 0,
      } as unknown as ListTableRecordsResult);
    });
    const loaded = {
      manifest: { run: { actorId: baseManifest.run.actorId } },
      runtime: { queryBus: { execute } },
    } as unknown as LoadedCase;
    const before = selectedRecordIds.map((id) => ({ id, value: `value:${id}` }));

    const after = await snapshotSelectedValuesByIds({
      loaded,
      tableId: `tbl${'a'.repeat(16)}`,
      fieldId,
      selectedRecordIds,
    });

    expect(execute).toHaveBeenCalledTimes(2);
    const queries = execute.mock.calls.map(([, query]) => query);
    expect(queries.map((query) => query.selectedRecordIds?.length)).toEqual([1000, 1]);
    expect(queries[0]?.selectedRecordIds).toEqual(selectedRecordIds.slice(0, 1000));
    expect(queries[1]?.selectedRecordIds).toEqual(selectedRecordIds.slice(1000));
    expect(queries.map((query) => query.projection)).toEqual([[fieldId], [fieldId]]);
    expect(queries.map((query) => query.pagination.limit().toNumber())).toEqual([1000, 1]);
    expect(after).toHaveLength(1000);
    expect(selectedValuesAreUnchanged(before, after)).toBe(false);

    expect(
      await snapshotSelectedValuesByIds({
        loaded,
        tableId: `tbl${'a'.repeat(16)}`,
        fieldId,
        selectedRecordIds: [],
      })
    ).toEqual([]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('fails the run when the expected error does not happen or does not match', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-expect-error-wrong.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'reject-wrong-code',
            kind: 'expect-error',
            checkId: 'reject-wrong-code',
            expectedCode: 'validation.field.does_not_exist',
            unchanged: { table: 'Orders', field: 'Amount', selection: 'first', rows: 1 },
            step: {
              kind: 'write-update',
              table: 'Orders',
              field: 'Amount',
              rows: 1,
              batchSize: 1,
              typecast: false,
              value: { kind: 'literal', value: 'not-a-number' },
            },
          },
          {
            key: 'reject-no-error',
            kind: 'expect-error',
            checkId: 'reject-no-error',
            expectedCode: 'validation.field.invalid_value',
            step: {
              kind: 'write-update',
              table: 'Orders',
              field: 'Amount',
              rows: 1,
              batchSize: 1,
              typecast: false,
              value: { kind: 'literal', value: 42 },
            },
          },
          { key: 'flush', kind: 'flush-computed' },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 0,
    });

    const wrongCode = report.oracle.checks.find(
      (check) => check.checkId === 'reject-wrong-code#sample-0'
    );
    expect(wrongCode).toMatchObject({ status: 'fail' });
    expect(wrongCode?.message).toContain('validation.field.invalid_value');
    const noError = report.oracle.checks.find(
      (check) => check.checkId === 'reject-no-error#sample-0'
    );
    expect(noError).toMatchObject({ status: 'fail' });
    expect(noError?.message).toContain('the step succeeded');
    expect(report.verdict).toBe('fail');
  }, 240_000);

  it('rejects a missing cursor reference with an explicit error', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-cursor-missing.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'page-1',
            kind: 'query-core',
            table: 'Orders',
            query: { limit: 3, cursor: { fromOperation: 'never-ran' } },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(report.errors.join('\n')).toContain('bench.query.cursor_missing');
    expect(report.verdict).toBe('fail');
  }, 240_000);

  it('compares field values order-insensitively after normalization', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-normalized-values.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'set-amounts',
            kind: 'write-update',
            table: 'Orders',
            field: 'Amount',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'number-increment', start: 1, step: 1 },
          },
          { key: 'flush', kind: 'flush-computed' },
          {
            key: 'check-values',
            kind: 'checkpoint',
            check: {
              checkId: 'amounts-normalized',
              description: 'Amounts compare regardless of generated row order',
              obligationIds: ['obl-values-order'],
              kind: 'field-values',
              table: 'Orders',
              field: 'Amount',
              expected: [10, 9, 8, 7, 6, 5, 4, 3, 2, 1],
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(
      report.oracle.checks.find((check) => check.checkId === 'amounts-normalized')
    ).toMatchObject({ status: 'pass', rowsMatched: 10 });
  }, 240_000);

  it('compares query record ids with the full table set, never a count alone', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-record-id-set.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'page-all',
            kind: 'query-core',
            table: 'Orders',
            query: { limit: 100 },
          },
          {
            key: 'check-set',
            kind: 'checkpoint',
            check: {
              checkId: 'orders-id-set',
              description: 'The query returned every order exactly once',
              obligationIds: ['obl-id-set'],
              kind: 'query-record-ids',
              operations: ['page-all'],
              expectedTotal: 10,
              table: 'Orders',
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(report.oracle.checks.find((check) => check.checkId === 'orders-id-set')).toMatchObject({
      status: 'pass',
      actual: { total: 10, duplicates: 0, setSize: 10 },
    });
  }, 240_000);

  it('continues cursor pages from the recorded nextCursor without duplicates', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-cursor-pages.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          { key: 'page-1', kind: 'query-core', table: 'Orders', query: { limit: 3 } },
          {
            key: 'page-2',
            kind: 'query-core',
            table: 'Orders',
            query: { limit: 4, cursor: { fromOperation: 'page-1' } },
          },
          {
            key: 'page-3',
            kind: 'query-core',
            table: 'Orders',
            query: { limit: 5, cursor: { fromOperation: 'page-2' } },
          },
          {
            key: 'check-pages',
            kind: 'checkpoint',
            check: {
              checkId: 'cursor-pages',
              description: 'Cursor pages cover every order exactly once',
              obligationIds: ['obl-cursor-pages'],
              kind: 'query-record-ids',
              operations: ['page-1', 'page-2', 'page-3'],
              expectedTotal: 10,
              table: 'Orders',
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 1,
    });

    expect(
      report.oracle.checks.find((check) => check.checkId === 'cursor-pages#sample-2')
    ).toMatchObject({ status: 'pass', actual: { total: 10, duplicates: 0, setSize: 10 } });
    expect(report.errors).toEqual([]);
    expect(report.verdict).toBe('pass');
  }, 240_000);

  it('compares ordered query values for a filtered, sorted page', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-query-values-ordered.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'set-amounts',
            kind: 'write-update',
            table: 'Orders',
            field: 'Amount',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'number-increment', start: 1, step: 1 },
          },
          { key: 'flush', kind: 'flush-computed' },
          {
            key: 'top-three',
            kind: 'query-core',
            table: 'Orders',
            query: {
              projection: ['Amount'],
              sort: [{ fieldId: 'Amount', order: 'desc' }],
              limit: 3,
            },
          },
          {
            key: 'check-values',
            kind: 'checkpoint',
            check: {
              checkId: 'top-three-values',
              description: 'The sorted page returns the exact top three amounts',
              obligationIds: ['obl-sort-values'],
              kind: 'query-values',
              operations: ['top-three'],
              ordered: true,
              expected: [{ Amount: 10 }, { Amount: 9 }, { Amount: 8 }],
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(
      report.oracle.checks.find((check) => check.checkId === 'top-three-values')
    ).toMatchObject({
      status: 'pass',
      method: 'exact-query-values-ordered',
      rowsMatched: 3,
    });
    expect(report.errors).toEqual([]);
  }, 240_000);

  it('compares unordered query values as a normalized multiset', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-query-values-multiset.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'set-amounts',
            kind: 'write-update',
            table: 'Orders',
            field: 'Amount',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'number-increment', start: 1, step: 1 },
          },
          { key: 'flush', kind: 'flush-computed' },
          {
            key: 'high-amounts',
            kind: 'query-core',
            table: 'Orders',
            query: {
              projection: ['Amount'],
              filter: { fieldId: 'Amount', operator: 'isGreaterEqual', value: 8 },
              limit: 10,
            },
          },
          {
            key: 'check-values',
            kind: 'checkpoint',
            check: {
              checkId: 'high-amounts-values',
              description: 'Filtered amounts match regardless of order',
              obligationIds: ['obl-filter-values'],
              kind: 'query-values',
              operations: ['high-amounts'],
              expected: [{ Amount: 9 }, { Amount: 8 }, { Amount: 10 }],
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(
      report.oracle.checks.find((check) => check.checkId === 'high-amounts-values')
    ).toMatchObject({
      status: 'pass',
      method: 'exact-query-values-multiset',
      rowsMatched: 3,
    });
  }, 240_000);

  it('preserves structured query aliases in query-values checkpoints', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-query-values-structured.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'set-amounts',
            kind: 'write-update',
            table: 'Orders',
            field: 'Amount',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'number-increment', start: 1, step: 1 },
          },
          { key: 'flush', kind: 'flush-computed' },
          {
            key: 'structured-top-two',
            kind: 'query-structured',
            definition: {
              version: 1,
              kind: 'records',
              tableId: 'Orders',
              select: [{ fieldId: 'Amount', alias: 'amount' }],
              sort: [{ fieldId: 'Amount', order: 'desc' }],
              page: { limit: 2 },
            },
          },
          {
            key: 'check-values',
            kind: 'checkpoint',
            check: {
              checkId: 'structured-values',
              description: 'Structured aliases carry the projected values',
              obligationIds: ['obl-structured-values'],
              kind: 'query-values',
              operations: ['structured-top-two'],
              ordered: true,
              expected: [{ amount: 10 }, { amount: 9 }],
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(
      report.oracle.checks.find((check) => check.checkId === 'structured-values')
    ).toMatchObject({
      status: 'pass',
      method: 'exact-query-values-ordered',
      rowsMatched: 2,
    });
  }, 240_000);

  it('fails an ordered query-values checkpoint when the sequence differs', async () => {
    const variant = await writeManifestVariant({
      base: baseCase,
      dir: workDir,
      file: 'checkpoint-query-values-mismatch.manifest.json',
      mutate: (manifest) => ({
        ...manifest,
        workload: [
          {
            key: 'set-amounts',
            kind: 'write-update',
            table: 'Orders',
            field: 'Amount',
            rows: 10,
            batchSize: 10,
            typecast: false,
            value: { kind: 'number-increment', start: 1, step: 1 },
          },
          { key: 'flush', kind: 'flush-computed' },
          {
            key: 'top-two',
            kind: 'query-core',
            table: 'Orders',
            query: {
              projection: ['Amount'],
              sort: [{ fieldId: 'Amount', order: 'desc' }],
              limit: 2,
            },
          },
          {
            key: 'check-values',
            kind: 'checkpoint',
            check: {
              checkId: 'wrong-order-values',
              description: 'The sorted sequence must match exactly',
              obligationIds: ['obl-sort-mismatch'],
              kind: 'query-values',
              operations: ['top-two'],
              ordered: true,
              expected: [{ Amount: 9 }, { Amount: 10 }],
            },
          },
        ],
      }),
    });

    const report = await runCase({
      teaPath: variant.teaPath,
      manifestPath: variant.manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(
      report.oracle.checks.find((check) => check.checkId === 'wrong-order-values')
    ).toMatchObject({
      status: 'fail',
      method: 'exact-query-values-ordered',
      message: 'Query values differ from the expected sequence',
    });
    expect(report.verdict).toBe('fail');
  }, 240_000);
});

describe('runCase with an imported rating maximum', () => {
  let dir: string | undefined;

  afterAll(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
  });

  it('keeps write-create values inside the imported rating maximum', async () => {
    const structure = {
      tables: [
        {
          id: 'tblratingmaxone0001',
          name: 'Items',
          fields: [
            { id: 'fldratingmaxname01', name: 'Name', type: 'singleLineText', isPrimary: true },
            {
              id: 'fldratingmaxstar001',
              name: 'OneStar',
              type: 'rating',
              options: { max: 1, icon: 'star', color: 'yellowBright' },
            },
          ],
          views: [{ id: 'viwratingmaxview001', type: 'grid', name: 'Grid' }],
        },
      ],
    };
    const rows = { Items: 2 };
    const seed = { schema: 11, data: 12, query: 13, schedule: 14 };
    const recipe: NonNullable<BenchCaseManifest['dataset']['recipe']> = {
      tables: { Items: { fields: { Name: {}, OneStar: {} } } },
    };
    const workload: BenchCaseManifest['workload'] = [
      {
        key: 'create-items',
        kind: 'write-create',
        table: 'Items',
        rows: 4,
        batchSize: 2,
        typecast: false,
      },
      {
        key: 'check-rating-values',
        kind: 'checkpoint',
        check: {
          checkId: 'rating-max-values',
          description: 'Seeded and created ratings stay inside the imported maximum of one',
          obligationIds: ['obl-rating-max'],
          kind: 'field-values',
          table: 'Items',
          field: 'OneStar',
          expected: [1, 1, 1, 1, 1, 1],
        },
      },
    ];
    const oracle: BenchCaseManifest['oracle'] = [
      {
        key: 'invariants',
        kind: 'invariant',
        checks: [
          { type: 'row-count', table: 'Items', expected: 6 },
          { type: 'unique-primary', table: 'Items' },
        ],
      },
    ];
    const dataHash = computeDatasetHash({ dataMode: 'recipe', rows, seed, recipe });
    const manifest: BenchCaseManifest = {
      caseId: computeCaseId({
        specVersion: 1,
        generatorVersion: 'test/1',
        schemaHash: sha256Hex(canonicalJson(structure)),
        datasetHash: dataHash,
        workload,
        oracle,
      }),
      specVersion: 1,
      generatorVersion: 'test/1',
      title: 'Rating maximum write-create regression',
      source: { tea: 'rating-max.tea', dataMode: 'recipe' },
      dataset: { rows, seed, recipe, dataHash },
      run: {
        backend: 'pglite',
        samples: 1,
        warmup: 1,
        repetitions: 1,
        seedBatchSize: 25,
        actorId: 'usr_headless',
      },
      workload,
      oracle,
    };
    dir = await mkdtemp(join(tmpdir(), 'headless-bench-rating-'));
    const teaPath = join(dir, 'rating-max.tea');
    const manifestPath = join(dir, 'rating-max.manifest.json');
    await writeFile(teaPath, writeTeaArchive(structure));
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

    const report = await runCase({
      teaPath,
      manifestPath,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 1,
    });

    expect(report.errors).toEqual([]);
    const create = report.operations.find((operation) => operation.key === 'create-items');
    expect(create).toMatchObject({
      kind: 'write-create',
      errors: 0,
      count: 1,
      rowsWritten: 4,
    });
    expect(create?.observation?.recordIds).toHaveLength(4);
    expect(
      report.oracle.checks.find((check) => check.checkId === 'rating-max-values')
    ).toMatchObject({
      status: 'pass',
      method: 'exact-field-values',
      field: 'OneStar',
      expected: [1, 1, 1, 1, 1, 1],
      actual: [1, 1, 1, 1, 1, 1],
      rowsMatched: 6,
    });
    expect(report.oracle.status).toBe('pass');
    expect(report.verdict).toBe('pass');
  }, 180_000);
});
