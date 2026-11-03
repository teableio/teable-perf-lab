import { describe, expect, it } from 'vitest';

import { CORE_SCALE_OPERATIONS, runCoreScaleBench } from './runner';
import {
  CORE_SCALE_SCENARIOS,
  coreScaleCaseId,
  CORE_SCALE_BASELINE_AMOUNT,
  CORE_SCALE_TARGET_AMOUNT,
  deterministicFanoutRow,
  deterministicSourceRow,
  resolveCoreScale,
} from './scenarios';

describe('core scale scenarios', () => {
  it('keeps the deterministic CI and opt-in large profiles at real scale', () => {
    expect(CORE_SCALE_SCENARIOS.ci).toMatchObject({
      baseRows: 10_000,
      fanoutRows: 1_000,
    });
    expect(CORE_SCALE_SCENARIOS.large.baseRows).toBeGreaterThan(CORE_SCALE_SCENARIOS.ci.baseRows);
    expect(CORE_SCALE_SCENARIOS.large.fanoutRows).toBeGreaterThan(
      CORE_SCALE_SCENARIOS.ci.fanoutRows
    );
    expect(resolveCoreScale()).toEqual(CORE_SCALE_SCENARIOS.ci);
    expect(resolveCoreScale({ baseRows: 12, fanoutRows: 4, batchSize: 3 })).toEqual({
      baseRows: 12,
      fanoutRows: 4,
      batchSize: 3,
    });
    expect(coreScaleCaseId({ baseRows: 12, fanoutRows: 4, batchSize: 3 })).toBe(
      'headless-core-scale-computed-fanout-v1-12r-4f-3b'
    );
    expect(coreScaleCaseId(CORE_SCALE_SCENARIOS.large)).not.toBe(
      coreScaleCaseId(CORE_SCALE_SCENARIOS.ci)
    );
  });

  it('generates stable indexed source and fanout data', () => {
    expect(deterministicSourceRow(0)).toEqual({ title: 'source-00000000', amount: 7 });
    expect(deterministicSourceRow(98)).toEqual({ title: 'source-00000098', amount: 101 });
    expect(deterministicFanoutRow(42)).toEqual({
      title: 'fanout-00000042',
      bucket: 'included',
    });
  });

  it('rejects invalid scale values', () => {
    expect(() => resolveCoreScale({ baseRows: 0 })).toThrow(/baseRows must be a positive integer/);
    expect(() => resolveCoreScale({ fanoutRows: -1 })).toThrow(
      /fanoutRows must be a positive integer/
    );
    expect(() => resolveCoreScale({ batchSize: 1_001 })).toThrow(/must not exceed/);
  });
});

describe('runCoreScaleBench', () => {
  it('rejects sample counts that cannot produce measurements', async () => {
    await expect(runCoreScaleBench({ backend: 'pglite', samples: 0, warmup: 0 })).rejects.toThrow(
      /samples must be a positive integer/
    );
    await expect(runCoreScaleBench({ backend: 'pglite', samples: 1, warmup: -1 })).rejects.toThrow(
      /warmup must be a non-negative integer/
    );
  });

  it('updates one source through linked lookup, rollup, formula, and conditional fanout', async () => {
    const result = await runCoreScaleBench({
      backend: 'pglite',
      samples: 1,
      warmup: 1,
      scale: { baseRows: 12, fanoutRows: 4, batchSize: 3 },
    });

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.correctness).toBe('pass');
    expect(result.caseId).toBe('headless-core-scale-computed-fanout-v1-12r-4f-3b');
    expect(result.backend).toBe('pglite');
    expect(result.operations.map(({ key }) => key)).toEqual(
      CORE_SCALE_OPERATIONS.map(({ key }) => key)
    );
    expect(
      result.operations.every(
        ({ count, samplesMs, errors }) =>
          count === 1 && samplesMs.length === 1 && samplesMs[0]! >= 0 && errors === 0
      )
    ).toBe(true);
    expect(
      result.operations.find(({ key }) => key === 'core:UpdateRecordCommand/source-amount')
    ).toMatchObject({ rowsWritten: 1 });
    expect(
      result.operations.find(
        ({ key }) => key === 'core:IHeadlessRuntime.flushComputed/source-fanout'
      )?.processed
    ).toBeGreaterThan(0);
    expect(
      result.operations.find(({ key }) => key === 'core:ListTableRecordsQuery/fanout-page')
    ).toMatchObject({ rowsRead: 4, rowsReturned: 4 });
    expect(result.dimensions).toMatchObject({
      baseRows: 12,
      fanoutRows: 4,
      seededRows: 17,
      deterministicRecipe: 'indexed-source-and-fanout-v1',
      setupTiming: 'excluded',
      samplePreparationTiming: 'excluded',
      measuredTiming:
        'target UpdateRecordCommand, target flushComputed, and target ListTableRecordsQuery only',
      caseIdentityVersion: 1,
      scaleIdentity: 'headless-core-scale-computed-fanout-v1-12r-4f-3b',
      sampleInvariant: {
        baselineAmount: CORE_SCALE_BASELINE_AMOUNT,
        targetAmount: CORE_SCALE_TARGET_AMOUNT,
        measuredTransition: 'constant baseline-to-target update on one reused seeded graph',
      },
      excludedCapabilities: ['undo', 'redo', 'realtime'],
    });
  }, 120_000);
});
