import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sha256Hex } from '../case/canonicalJson';
import { computeDatasetHash, type BenchCaseManifest } from '../case/manifest';
import { loadDeclaredBusinessTopology } from '../cli/handlers';
import { serializeBenchEvidence } from '../evidence/serialize';
import type { BenchRunReport } from '../runner/BenchRunner';
import { writeTeaArchive } from '../tea/teaZip';
import { captureInvocation, capturedEvidenceInput, defaultEvidencePlan } from './capture';

const manifest: BenchCaseManifest = {
  caseId: `sha256:${'0'.repeat(64)}`,
  specVersion: 1,
  generatorVersion: 'test/1',
  title: 'single manifest',
  source: { tea: 'fixture.tea', dataMode: 'recipe' },
  dataset: {
    rows: { Records: 1 },
    seed: { schema: 1, data: 1, query: 1, schedule: 1 },
    recipe: { tables: { Records: { fields: {} } } },
  },
  run: {
    backend: 'pglite',
    samples: 3,
    warmup: 1,
    repetitions: 1,
    seedBatchSize: 100,
    actorId: 'usr_test',
  },
  workload: [{ key: 'read', kind: 'query-core', table: 'Records', query: {} }],
  oracle: [
    {
      key: 'rows',
      kind: 'invariant',
      checks: [{ type: 'row-count', table: 'Records', expected: 1 }],
    },
  ],
};

const repetition = (index: number): BenchRunReport['repetitions'][number] => ({
  index,
  setup: { importMs: 1, resolveMs: 1, seedMs: 1, flushMs: 1, totalRows: 1 },
  phases: [],
  operations: [],
  oracle: { status: 'pass', checks: [], warnings: [] },
  verdict: 'pass',
  errors: [],
  warnings: [],
});

const runReport = (input: {
  manifestPath: string;
  teaPath: string;
  backend?: BenchRunReport['backend'];
  samples?: number;
  warmup?: number;
  repetitions?: number;
}): BenchRunReport => ({
  runId: 'run-1',
  caseId: manifest.caseId,
  specVersion: 1,
  generatorVersion: manifest.generatorVersion,
  seed: manifest.dataset.seed,
  warmup: input.warmup ?? 1,
  samples: input.samples ?? 3,
  title: manifest.title,
  backend: input.backend ?? 'pglite',
  commit: '0123456789abcdef0123456789abcdef01234567',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
  manifestPath: input.manifestPath,
  teaPath: input.teaPath,
  environment: {
    node: 'v24.0.0',
    platform: 'linux',
    arch: 'x64',
    runtime: 'node v24.0.0',
    computationMode: 'hybrid-inline-and-flush',
    ...(input.backend === 'postgres' ? { pgVersion: '17.4' } : {}),
  },
  complexity: { profile: {} as never, assessments: {}, warnings: [] },
  budgets: undefined,
  repetitions: Array.from({ length: input.repetitions ?? 1 }, (_, index) => repetition(index)),
  operations: [],
  oracle: { status: 'pass', checks: [], warnings: [] },
  verdict: 'pass',
  correctnessVerdict: 'pass',
  performanceVerdict: 'not-compared',
  errors: [],
  warnings: [],
});

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('defaultEvidencePlan', () => {
  it('scopes a normal run to its selected scenario only', () => {
    const plan = defaultEvidencePlan(manifest, 3);
    expect(plan.scope.registry).toMatchObject({ kind: 'selected', scenarioIds: [manifest.caseId] });
    expect(plan.suiteReceipts).toHaveLength(1);
    expect(plan.suiteReceipts[0]).toMatchObject({
      scenarioId: manifest.caseId,
      planned: true,
      execution: 'not-executed',
    });
  });
});

describe('capturedEvidenceInput', () => {
  it('serializes materialized data and loads a moved verified archive', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tea-bench-evidence-'));
    temporaryDirectories.push(directory);
    const originalTeaPath = join(directory, 'fixture.tea');
    const movedTeaPath = join(directory, 'moved.tea');
    const manifestPath = join(directory, 'case.json');
    const csvByEntry = { 'tables/Records.csv': 'Name\nA\n' };
    const teaBytes = writeTeaArchive(
      { tables: [{ id: 'tblRecords', name: 'Records', fields: [] }] },
      csvByEntry
    );
    const materializedManifest: BenchCaseManifest = {
      ...manifest,
      source: { tea: 'fixture.tea', dataMode: 'materialized' },
      dataset: {
        rows: manifest.dataset.rows,
        seed: manifest.dataset.seed,
        dataHash: computeDatasetHash({
          dataMode: 'materialized',
          rows: manifest.dataset.rows,
          seed: manifest.dataset.seed,
          csvByEntry: new Map(Object.entries(csvByEntry)),
        }),
      },
    };
    await writeFile(originalTeaPath, teaBytes);
    await writeFile(movedTeaPath, teaBytes);
    await writeFile(manifestPath, JSON.stringify(materializedManifest));

    const captured = await captureInvocation(manifestPath, movedTeaPath, 'materialized');
    const run = runReport({ manifestPath, teaPath: movedTeaPath });
    const evidence = serializeBenchEvidence(
      run,
      capturedEvidenceInput({
        run,
        manifest: materializedManifest,
        captured,
        outPath: join(directory, 'run.json'),
      })
    );
    await rm(originalTeaPath);

    expect(evidence.provenance.dataHash).toBe(materializedManifest.dataset.dataHash);
    expect(evidence.provenance.dataHash).not.toBe(evidence.provenance.fixtureHash);
    expect(evidence.provenance.fixtureHash).toBe(sha256Hex(teaBytes));
    expect(evidence.provenance.reproducibility.inputs).toContainEqual({
      path: movedTeaPath,
      sha256: sha256Hex(teaBytes),
    });
    await expect(loadDeclaredBusinessTopology(evidence)).resolves.toEqual({
      tables: [{ id: 'tblRecords', name: 'Records' }],
      links: [],
    });
  });

  it('replays actual overrides with the captured executable and no connection secret', () => {
    const run = runReport({
      manifestPath: '/cases/actual.json',
      teaPath: '/fixtures/override.tea',
      backend: 'postgres',
      samples: 11,
      warmup: 2,
      repetitions: 4,
    });
    const input = capturedEvidenceInput({
      run,
      manifest,
      outPath: '/reports/actual-run.json',
      captured: {
        dirty: false,
        sourceHash: '1'.repeat(64),
        fixtureHash: '2'.repeat(64),
        manifestHash: '3'.repeat(64),
        executablePath: '/opt/node/bin/node',
        entrypointPath: '/workspace/headless-bench/dist/cli.js',
        cwd: '/workspace/headless-bench',
        host: {
          os: 'linux',
          arch: 'x64',
          cpu: 'test',
          logicalCpuCount: 1,
          memoryBytes: 1,
        },
      },
    });

    const command = input.reproducibility.commands[0]!;
    expect(command.argv).toEqual([
      '/opt/node/bin/node',
      '/workspace/headless-bench/dist/cli.js',
      'run',
      '--case',
      '/cases/actual.json',
      '--tea',
      '/fixtures/override.tea',
      '--backend',
      'postgres',
      '--samples',
      '11',
      '--warmup',
      '2',
      '--repetitions',
      '4',
      '--out',
      '/reports/actual-run.json',
    ]);
    expect(command.cwd).toBe('/workspace/headless-bench');
    expect(command.label).toEqual(expect.any(String));
    expect(input.reproducibility.environment.TEABLE_BENCH_CONNECTION).toEqual(expect.any(String));
    expect(JSON.stringify(input.reproducibility)).not.toContain('postgresql://');
  });
});
