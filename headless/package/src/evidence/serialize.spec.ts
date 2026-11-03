import { describe, expect, it } from 'vitest';

import { exportTeaBenchReportRows } from '../report/exportTeable';
import type { CreateTeaBenchReportFromRunInput } from '../report/fromBenchRun';
import type { BenchRunReport } from '../runner/BenchRunner';
import { serializeBenchEvidence } from './serialize';

const sha = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const run: BenchRunReport = {
  runId: 'run-1',
  caseId: 'scenario-1',
  specVersion: 1,
  generatorVersion: 'tea-bench/1',
  title: 'Evidence fixture',
  backend: 'pglite',
  commit: '0123456789abcdef0123456789abcdef01234567',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:01.000Z',
  manifestPath: '/cases/case.manifest.json',
  teaPath: '/cases/fixture.tea',
  environment: {
    node: 'v24',
    platform: 'darwin',
    arch: 'arm64',
    runtime: 'node v24',
    computationMode: 'hybrid-inline-and-flush',
  },
  seed: { schema: 1, data: 2, query: 3, schedule: 4 },
  warmup: 0,
  samples: 3,
  complexity: { profile: {} as never, assessments: {}, warnings: [] },
  budgets: undefined,
  repetitions: [],
  operations: [
    {
      key: 'read',
      kind: 'query-core',
      samplesMs: [4, 5, 6],
      count: 3,
      minMs: 4,
      p50Ms: 5,
      p95Ms: 6,
      p99Ms: 6,
      maxMs: 6,
      meanMs: 5,
      rowsRead: 12,
      rowsWritten: 0,
      rowsReturned: 8,
      processed: 0,
      errors: 0,
      warnings: [],
    },
  ],
  oracle: { status: 'pass', checks: [], warnings: [] },
  verdict: 'pass',
  errors: [],
  warnings: [],
};

const freshInput = (): CreateTeaBenchReportFromRunInput => ({
  mode: 'fresh',
  scope: {
    title: 'Configured scope',
    description: 'Complete configured benchmark scope.',
    registry: { kind: 'full-registry', scenarioIds: ['scenario-1'] },
    configured: { scenarioIds: ['scenario-1'], description: 'One selected scenario.' },
    included: ['scenario-1'],
    exclusions: [],
  },
  suiteReceipts: [],
  dataset: { name: 'fixture', description: 'Hashed fixture.', rowCounts: { Tasks: 8 } },
  commitDirty: false,
  dataHash: sha,
  fixtureHash: sha,
  toolVersions: { node: '24.0.0', bench: '0.0.0' },
  backend: { kind: 'pglite', version: '0.3.14' },
  postgres: null,
  host: { os: 'darwin', arch: 'arm64', cpu: 'test', logicalCpuCount: 8, memoryBytes: 1024 },
  reproducibility: {
    commands: [{ label: 'run', argv: ['pnpm', 'bench', 'run'] }],
    environment: {},
    inputs: [{ path: 'case.tea', sha256: sha }],
  },
  artifacts: [],
  performanceVerdict: 'not-compared',
});

describe('serializeBenchEvidence', () => {
  it('exports a validated tea-bench-report/2 report and canonical Teable rows', () => {
    const evidence = serializeBenchEvidence(run, freshInput());
    const rows = exportTeaBenchReportRows(evidence);

    expect(evidence).toMatchObject({
      schema: 'tea-bench-report/2',
      evidenceKind: 'observed',
      executions: [{ runId: 'run-1', scenarioId: 'scenario-1' }],
    });
    expect(rows.runRows).toHaveLength(1);
    expect(rows.operationRows).toHaveLength(1);
    expect(rows.runRows[0]).toMatchObject({ schema: 'tea-bench-report/2', runId: 'run-1' });
    expect(rows.operationRows[0]).toMatchObject({ key: 'read', attempted: 3, success: 3 });
    expect(JSON.parse(String(rows.runRows[0]?.reportRawJson))).toEqual(evidence);
  });

  it('rejects legacy adapter input rather than relabelling unknown provenance', () => {
    expect(() => serializeBenchEvidence(run, { ...freshInput(), mode: 'legacy' })).toThrow(
      'requires an explicit fresh adapter input'
    );
  });

  it('rejects fresh evidence without captured hashes', () => {
    expect(() => serializeBenchEvidence(run, { ...freshInput(), dataHash: null })).toThrow(
      'Fresh reports require explicit data and fixture hashes'
    );
  });
});
