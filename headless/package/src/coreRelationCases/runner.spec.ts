import { describe, expect, it } from 'vitest';

import { CORE_RELATION_CASES } from './cases';
import { runCoreRelationCasesBench } from './runner';

describe('runCoreRelationCasesBench', () => {
  it('preserves exact forward, reverse, lookup, and rollup relation semantics', async () => {
    const result = await runCoreRelationCasesBench({
      backend: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.correctness).toBe('pass');
    expect(result.caseId).toBe('headless-core-relation-cases-v1');
    expect(result.backend).toBe('pglite');
    expect(result.operations.map(({ key }) => key)).toEqual(
      CORE_RELATION_CASES.map(({ key }) => key)
    );
    expect(
      result.operations.every(
        ({ count, samplesMs, errors }) =>
          count === 1 &&
          samplesMs.length === 1 &&
          samplesMs.every((latencyMs) => Number.isFinite(latencyMs) && latencyMs >= 0) &&
          errors === 0
      )
    ).toBe(true);

    expect(
      result.operations.find(
        ({ key }) => key === 'core:UpdateRecordsCommand/many-one-fanout-assign'
      )
    ).toMatchObject({ rowsWritten: 48 });
    expect(
      result.operations.find(({ key }) => key === 'core:UpdateRecordsCommand/many-one-reassign')
    ).toMatchObject({ rowsWritten: 16 });
    expect(
      result.operations.find(({ key }) => key === 'core:UpdateRecordsCommand/many-one-clear')
    ).toMatchObject({ rowsWritten: 8 });
    expect(
      result.operations.find(({ key }) => key === 'core:DeleteRecordsCommand/linked-parent-target')
    ).toMatchObject({ rowsWritten: 1 });
    expect(
      result.operations.find(
        ({ key }) => key === 'core:IHeadlessRuntime.flushComputed/many-one-fanout-assign'
      )?.processed
    ).toBeGreaterThan(0);
    expect(
      result.operations.find(
        ({ key }) => key === 'core:IHeadlessRuntime.flushComputed/linked-parent-target-delete'
      )?.processed
    ).toBeGreaterThan(0);

    expect(result.dimensions).toMatchObject({
      caseIdentityVersion: 1,
      profileRows: 3,
      userRows: 1,
      parentRows: 3,
      childRows: 48,
      initialFanoutRows: 48,
      reassignedRows: 16,
      clearedRows: 8,
      setupTiming: 'base-table-and-record-fixture-excluded',
      computedDrainTiming: 'measured-separately-from-triggering-command',
      persistedReadbackTiming: 'excluded',
      excludedCapabilities: ['undo', 'redo', 'realtime'],
    });
    expect(result.dimensions['relationCoverage']).toEqual([
      'bidirectional one-to-one creation with generated reverse one-to-one schema',
      'bidirectional many-to-one creation with generated reverse one-to-many schema',
      'one-to-one assignment, reassignment, and clearing with exact reverse cells',
      'many-to-one fanout assignment, reassignment, and clearing with exact reverse membership',
      'linked parent deletion clears surviving child links and dependent computed values',
      'forward and reverse lookup and rollup persisted values after every computed drain',
    ]);
  }, 120_000);
});
