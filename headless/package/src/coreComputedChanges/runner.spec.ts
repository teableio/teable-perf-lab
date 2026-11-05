import { describe, expect, it } from 'vitest';

import { CORE_COMPUTED_CHANGES_CASES } from './cases';
import { runCoreComputedChangesBench } from './runner';

describe('runCoreComputedChangesBench', () => {
  it('recomputes populated formulas and linked lookup/rollup values through update, unlink, and relink', async () => {
    const result = await runCoreComputedChangesBench({
      backend: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.correctness).toBe('pass');
    expect(result.caseId).toBe('headless-core-computed-changes-v1');
    expect(result.backend).toBe('pglite');
    expect(result.operations.map(({ key }) => key)).toEqual(
      CORE_COMPUTED_CHANGES_CASES.map(({ key }) => key)
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

    for (const key of [
      'core:CreateFieldCommand/formula-populated',
      'core:UpdateFieldCommand/formula-expression',
    ]) {
      expect(result.operations.find((operation) => operation.key === key)).toMatchObject({
        rowsWritten: 64,
      });
    }
    for (const key of [
      'core:UpdateRecordCommand/linked-source-update',
      'core:UpdateRecordCommand/link-unlink',
      'core:UpdateRecordCommand/link-relink',
    ]) {
      expect(result.operations.find((operation) => operation.key === key)).toMatchObject({
        rowsWritten: 1,
      });
    }
    expect(
      result.operations.find(
        ({ key }) => key === 'core:IHeadlessRuntime.flushComputed/linked-source-update'
      )?.processed
    ).toBeGreaterThan(0);

    expect(result.dimensions).toMatchObject({
      caseIdentityVersion: 1,
      populatedHostRows: 64,
      linkedSourceRows: 2,
      setupTiming: 'excluded',
      computedDrainTiming: 'measured-separately-from-triggering-command',
      persistedReadbackTiming: 'excluded',
      correctnessValidation:
        'untimed ListFieldsQuery and ListTableRecordsQuery readback after every computed drain',
      sampleIsolation: {
        fixturePerRound:
          'fresh registered base with deterministic source and populated host tables',
        cleanup: 'cleanupBenchBase removes only the round-owned registered base',
        runtimeReuse:
          'one runtime across rounds; bases, tables, fields, and records are never reused',
      },
      excludedCapabilities: ['undo', 'redo', 'realtime'],
    });
    expect(result.dimensions['changeCoverage']).toEqual([
      'formula field creation backfills a populated table',
      'formula expression update recomputes every populated row',
      'linked source value update propagates to dependent lookup and rollup values',
      'unlink clears the selected host lookup and resets its rollup without changing other hosts',
      'relink restores the selected host lookup and rollup values',
    ]);
  }, 120_000);
});
