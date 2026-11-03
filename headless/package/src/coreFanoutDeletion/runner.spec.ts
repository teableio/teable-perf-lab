import { describe, expect, it } from 'vitest';

import {
  coreFanoutDeletionCaseId,
  CORE_FANOUT_DELETION_CASES,
  CORE_FANOUT_DELETION_CI_FANOUT,
  CORE_FANOUT_DELETION_LARGE_FANOUT,
  CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
} from './cases';
import { runCoreFanoutDeletionBench } from './runner';

describe('runCoreFanoutDeletionBench', () => {
  it('updates and deletes a linked source while checking every affected and unaffected row', async () => {
    const fanout = 4;
    const result = await runCoreFanoutDeletionBench({
      backend: 'pglite',
      samples: 1,
      warmup: 0,
      fanout,
    });

    expect(result.correctness, result.errors.join('\n')).toBe('pass');
    expect(result.errors).toEqual([]);
    expect(result.caseId).toBe(coreFanoutDeletionCaseId(fanout));
    expect(result.operations.map(({ key }) => key)).toEqual(
      CORE_FANOUT_DELETION_CASES.map(({ key }) => key)
    );
    expect(result.operations.every(({ count, errors }) => count === 1 && errors === 0)).toBe(true);
    expect(result.operations.find(({ key }) => key.includes('UpdateRecordCommand'))).toMatchObject({
      rowsWritten: 1,
    });
    expect(result.operations.find(({ key }) => key.includes('DeleteRecordsCommand'))).toMatchObject(
      {
        rowsWritten: 1,
      }
    );
    expect(result.dimensions).toMatchObject({
      actualFanoutRows: fanout,
      unaffectedDependentRows: CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
      dependentRows: fanout + CORE_FANOUT_DELETION_UNAFFECTED_ROWS,
      ciFanoutRows: CORE_FANOUT_DELETION_CI_FANOUT,
      largeFanoutRows: CORE_FANOUT_DELETION_LARGE_FANOUT,
      setupTiming: 'excluded',
      cleanup: 'owned-base-cleanup-after-every-round-and-runtime-close',
    });
  }, 120_000);

  it('rejects a label-only or empty fanout instead of reporting an unexercised workload', async () => {
    await expect(
      runCoreFanoutDeletionBench({
        backend: 'pglite',
        samples: 1,
        warmup: 0,
        fanout: 0,
      })
    ).rejects.toThrow('fanout must be a positive integer');
  });
});
