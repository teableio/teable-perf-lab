import { describe, expect, it } from 'vitest';

import { CORE_TRANSITIONS_OPERATIONS, runCoreTransitionsBench } from './runner';

describe('runCoreTransitionsBench', () => {
  it('persists linked create/delete and conditional rollup enter/leave transitions on PGlite', async () => {
    const result = await runCoreTransitionsBench({
      backend: 'pglite',
      samples: 2,
      warmup: 1,
    });

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.correctness).toBe('pass');
    expect(result.caseId).toBe('headless-core-transitions-v1');
    expect(result.backend).toBe('pglite');
    expect(result.operations.map(({ key }) => key)).toEqual(
      CORE_TRANSITIONS_OPERATIONS.map(({ key }) => key)
    );
    expect(
      result.operations.every(
        ({ count, samplesMs, errors }) =>
          count === 2 &&
          samplesMs.length === 2 &&
          samplesMs.every((latencyMs) => Number.isFinite(latencyMs) && latencyMs >= 0) &&
          errors === 0
      )
    ).toBe(true);

    for (const key of [
      'core:CreateRecordsCommand/linked-record',
      'core:UpdateRecordCommand/conditional-rollup-enter',
      'core:UpdateRecordCommand/conditional-rollup-leave',
      'core:DeleteRecordsCommand/linked-record',
    ]) {
      expect(result.operations.find((operation) => operation.key === key)).toMatchObject({
        rowsWritten: 2,
      });
    }
    expect(
      result.operations.find(
        ({ key }) => key === 'core:IHeadlessRuntime.flushComputed/conditional-rollup-enter'
      )?.processed
    ).toBeGreaterThan(0);

    expect(result.dimensions).toMatchObject({
      caseIdentityVersion: 1,
      setupTiming: 'excluded',
      persistedReadbackTiming: 'excluded',
      correctnessValidation: 'exact untimed ListTableRecordsQuery readback after every drain',
      sampleIsolation: {
        fixturePerRound: 'fresh registered base with deterministic schema and one host record',
        initialState: 'zero item rows and conditional rollup count 0',
        finalState: 'zero item rows and conditional rollup count 0',
        cleanup: 'cleanupBenchBase removes only the round-owned registered base',
        runtimeReuse: 'one runtime across rounds; no records or bases are reused between samples',
      },
      persistedReadback: {
        finalEmptyState: { itemRows: 0, conditionalRollupCount: 0 },
      },
      excludedCapabilities: ['undo', 'redo', 'realtime'],
    });
    expect(result.dimensions['transitionCoverage']).toEqual([
      'linked record create: persisted item scalars and exact host link id; rollup remains 0',
      'conditional membership enter: persisted status included; rollup becomes 1',
      'conditional membership leave: persisted status excluded; rollup returns to 0',
      'linked record delete: persisted item table is empty; rollup remains 0',
    ]);
  }, 120_000);
});
