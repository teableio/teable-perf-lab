import { describe, expect, it } from 'vitest';

import type { BenchRunReport } from '../runner/BenchRunner';
import { deterministicTestReport } from './fixtures/deterministicReport';
import { createTeaBenchReportFromRun, type CreateTeaBenchReportFromRunInput } from './fromBenchRun';

const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const run = (): BenchRunReport => ({
  runId: 'run-1',
  caseId: 'scenario-1',
  specVersion: 1,
  generatorVersion: 'generator/1',
  seed: { schema: 1, data: 2, query: 3, schedule: 4 },
  warmup: 1,
  samples: 2,
  title: 'Actual run',
  backend: 'pglite',
  commit: '0123456789abcdef0123456789abcdef01234567',
  startedAt: '2026-10-27T01:00:00.000Z',
  completedAt: '2026-10-27T01:00:02.000Z',
  manifestPath: 'case.json',
  teaPath: 'case.tea',
  environment: {
    node: 'v24.0.0',
    platform: 'darwin',
    arch: 'arm64',
    runtime: 'node v24.0.0',
    computationMode: 'hybrid-inline-and-flush',
  },
  complexity: { profile: {} as never, assessments: {}, warnings: [] },
  budgets: undefined,
  repetitions: [
    {
      index: 0,
      setup: { importMs: 1, resolveMs: 1, seedMs: 1, flushMs: 1, totalRows: 2 },
      phases: [
        { kind: 'warmup', durationMs: 1 },
        { kind: 'measure', durationMs: 3 },
        { kind: 'oracle', durationMs: 1 },
      ],
      operations: [],
      oracle: { status: 'pass', checks: [], warnings: [] },
      verdict: 'pass',
      errors: [],
      warnings: [],
    },
  ],
  operations: [
    {
      key: 'read',
      kind: 'query-core',
      samplesMs: [1, 3],
      count: 2,
      minMs: 1,
      p50Ms: 1,
      p95Ms: 3,
      p99Ms: 3,
      maxMs: 3,
      meanMs: 2,
      rowsRead: 4,
      rowsWritten: 0,
      rowsReturned: 4,
      processed: 0,
      errors: 1,
      warnings: [],
    },
    {
      key: 'drain',
      kind: 'flush-computed',
      samplesMs: [2, 4],
      count: 2,
      minMs: 2,
      p50Ms: 2,
      p95Ms: 4,
      p99Ms: 4,
      maxMs: 4,
      meanMs: 3,
      rowsRead: 0,
      rowsWritten: 0,
      rowsReturned: 0,
      processed: 2,
      errors: 0,
      warnings: [],
    },
  ],
  oracle: {
    status: 'pass',
    warnings: [],
    checks: [
      {
        key: 'rows',
        checkId: 'check-rows',
        kind: 'invariant',
        status: 'pass',
        description: 'Rows match',
        table: 'Tasks',
        field: null,
        expected: 2,
        actual: 2,
        tolerance: 0,
        obligationIds: ['rule-rows'],
        rowsMatched: 2,
        method: 'row-count',
        details: { source: 'oracle' },
      },
    ],
  },
  verdict: 'inconclusive',
  errors: [],
  warnings: [],
});

const input = (): CreateTeaBenchReportFromRunInput => ({
  mode: 'fresh',
  scope: {
    title: 'Scope',
    description: 'Full configured benchmark scope.',
    registry: { kind: 'full-registry', scenarioIds: ['scenario-1', 'scenario-2'] },
    configured: { scenarioIds: ['scenario-1'], description: 'Selected scenario.' },
    included: ['scenario-1'],
    exclusions: [],
  },
  suiteReceipts: [
    {
      receiptId: 'receipt-1',
      suiteId: 'suite-1',
      scenarioId: 'scenario-1',
      executionRef: null,
      applicable: true,
      planned: true,
      execution: 'not-executed',
      reason: 'Awaiting run',
      rules: {
        plannedCount: 1,
        executedCount: 0,
        receipts: [
          {
            id: 'rule-rows',
            requiredCheckIds: ['check-rows'],
            planned: true,
            executed: false,
            status: 'not-executed',
            reason: 'Awaiting run',
          },
        ],
      },
      sources: { plannedCount: 0, executedCount: 0, receipts: [] },
      edges: { plannedCount: 0, executedCount: 0, receipts: [] },
    },
  ],
  dataset: { name: 'fixture', description: 'Captured fixture.', rowCounts: { Tasks: 2 } },
  commitDirty: false,
  dataHash: sha,
  fixtureHash: sha,
  toolVersions: { node: '24.0.0', bench: '0.0.0' },
  backend: { kind: 'pglite', version: '0.3.14' },
  postgres: null,
  host: { os: 'darwin', arch: 'arm64', cpu: 'test', logicalCpuCount: 8, memoryBytes: 1024 },
  reproducibility: {
    commands: [{ label: 'run', argv: ['pnpm', 'bench'] }],
    environment: {},
    inputs: [],
  },
  artifacts: [
    {
      artifactId: 'artifact-run',
      kind: 'json',
      path: 'run.json',
      sha256: sha,
      mediaType: 'application/json',
    },
  ],
  oracleEvidenceRefs: { ['check-rows']: ['artifact-run'] },
  performanceVerdict: 'not-compared',
});

it('preserves standalone SLO failure even if adapter metadata says not-compared', () => {
  const actual = { ...run(), performanceVerdict: 'fail' as const };
  const report = createTeaBenchReportFromRun(actual, input());
  expect(report.verdicts.performance).toBe('fail');
  expect(report.executions[0]?.verdicts.performance).toBe('fail');
});
describe('createTeaBenchReportFromRun', () => {
  it('keeps sacrificial warmup before each fresh sample setup and operation sequence', () => {
    const original = run();
    const source = {
      ...original,
      repetitions: [
        {
          ...original.repetitions[0]!,
          phases: [
            { kind: 'warmup' as const, durationMs: 1 },
            { kind: 'sample-setup' as const, sampleIndex: 0, durationMs: 10 },
            { kind: 'measure' as const, sampleIndex: 0, durationMs: 3 },
            { kind: 'oracle' as const, sampleIndex: 0, durationMs: 2 },
            { kind: 'sample-setup' as const, sampleIndex: 1, durationMs: 10 },
            { kind: 'measure' as const, sampleIndex: 1, durationMs: 3 },
            { kind: 'oracle' as const, sampleIndex: 1, durationMs: 2 },
          ],
        },
      ],
    };
    const result = createTeaBenchReportFromRun(source, input());
    expect(result.runtime.phaseEvents.map((event) => [event.kind, event.sampleIndex])).toEqual([
      ['warmup', undefined],
      ['sample-setup', 0],
      ['measurement', 0],
      ['drain', 0],
      ['sample-setup', 1],
      ['measurement', 1],
      ['drain', 1],
    ]);
  });

  it('converts actual samples, oracle receipts, order, and passing obligations without inventing a final drain', () => {
    const report = createTeaBenchReportFromRun(run(), input());
    const execution = report.executions[0]!;

    expect(execution.operations.map(({ key, phase }) => [key, phase])).toEqual([
      ['read', 'measurement'],
      ['drain', 'drain'],
    ]);
    expect(execution.operations[0]).toMatchObject({
      attempted: 3,
      success: 2,
      errors: 1,
      rawSamples: { values: [1, 3] },
    });
    expect(execution.correctness[0]).toMatchObject({
      checkId: 'check-rows',
      expected: 2,
      actual: 2,
      obligationIds: ['rule-rows'],
      evidenceRefs: ['artifact-run'],
    });
    expect(report.catalogue.suiteReceipts[0]?.rules.receipts[0]).toMatchObject({
      executed: true,
      status: 'pass',
    });
    expect(report.runtime.phaseEvents.filter(({ kind }) => kind === 'drain')).toHaveLength(1);
    expect(report.verdicts).toEqual({
      oracle: 'pass',
      execution: 'fail',
      performance: 'not-compared',
    });
  });

  it('rejects missing provenance in fresh mode and records explicit unknowns in legacy mode', () => {
    const fresh = input();
    expect(() =>
      createTeaBenchReportFromRun(run(), { ...fresh, commitDirty: null, dataHash: null })
    ).toThrow('Fresh reports require explicit commit dirty state');

    const legacy = createTeaBenchReportFromRun(run(), {
      ...fresh,
      mode: 'legacy',
      commitDirty: null,
      dataHash: null,
      fixtureHash: null,
      commitDirtyReason: 'Not captured by v1 runner',
      hashMissingReason: 'Not captured by v1 runner',
    });
    expect(legacy.provenance.reproducibility).toMatchObject({ state: 'unknown', immutable: false });
    expect(legacy.provenance.commit.dirtyReason).toBe('Not captured by v1 runner');
  });

  it('uses stable identities and preserves full registry separately from configured scope', () => {
    const first = createTeaBenchReportFromRun(run(), input());
    const second = createTeaBenchReportFromRun(run(), input());
    expect(second.ids).toEqual(first.ids);
    expect(first.scope.registry.scenarioIds).toEqual(['scenario-1', 'scenario-2']);
    expect(first.scope.configured.scenarioIds).toEqual(['scenario-1']);
    expect(first).not.toEqual(deterministicTestReport);
  });

  it('does not count an obligation as passed when another required assertion fails', () => {
    const base = run();
    const failing: BenchRunReport = {
      ...base,
      oracle: {
        status: 'fail',
        warnings: [],
        checks: [
          ...base.oracle.checks,
          {
            ...base.oracle.checks[0]!,
            checkId: 'check-rows-transition-2',
            status: 'fail',
            actual: 1,
            message: 'second transition failed',
          },
        ],
      },
      operations: base.operations.map((operation) => ({ ...operation, errors: 0 })),
    };
    const report = createTeaBenchReportFromRun(failing, input());
    expect(report.catalogue).toMatchObject({ executed: 1, pass: 0, fail: 1 });
    expect(report.catalogue.suiteReceipts[0]?.rules.receipts[0]).toMatchObject({
      executed: true,
      status: 'fail',
    });
    expect(report.verdicts).toMatchObject({ oracle: 'fail', execution: 'pass' });
  });

  it('does not verify obligations from legacy checks with unknown detail', () => {
    const baseRun = run();
    const legacyRun: BenchRunReport = {
      ...baseRun,
      oracle: {
        status: 'pass',
        warnings: [],
        checks: [
          {
            key: 'legacy',
            kind: 'expected-json',
            status: 'pass',
            obligationIds: ['rule-rows'],
          } as never,
        ],
      },
    };
    const base = input();
    const report = createTeaBenchReportFromRun(legacyRun, {
      ...base,
      mode: 'legacy',
      commitDirty: null,
      dataHash: null,
      fixtureHash: null,
      commitDirtyReason: 'not captured',
      hashMissingReason: 'not captured',
    });
    expect(report.executions[0]?.correctness[0]).toMatchObject({ status: 'unknown' });
    expect(report.catalogue.suiteReceipts[0]?.rules.receipts[0]).toMatchObject({
      executed: false,
      status: 'not-executed',
    });
  });

  it('keeps a planned obligation unverified when a required transition check is missing', () => {
    const base = input();
    const receipts = structuredClone(base.suiteReceipts);
    receipts[0]!.rules.receipts[0]!.requiredCheckIds = ['check-rows', 'check-restore'];
    const report = createTeaBenchReportFromRun(run(), { ...base, suiteReceipts: receipts });
    expect(report.catalogue.suiteReceipts[0]?.rules.receipts[0]).toMatchObject({
      executed: false,
      status: 'not-executed',
    });
    expect(report.catalogue).toMatchObject({ executed: 1, pass: 0, fail: 1 });
  });
});
