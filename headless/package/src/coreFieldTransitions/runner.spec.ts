import { describe, expect, it } from 'vitest';

import { CORE_FIELD_TRANSITIONS_CASES } from './cases';
import { runCoreFieldTransitionsBench } from './runner';

describe('runCoreFieldTransitionsBench', () => {
  it('converts mixed populated values, recomputes a formula chain, and rejects invalid expressions without losing data', async () => {
    const result = await runCoreFieldTransitionsBench({
      backend: 'pglite',
      samples: 2,
      warmup: 1,
    });

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.correctness).toBe('pass');
    expect(result.caseId).toBe('headless-core-field-transitions-mixed-64-v1');
    expect(result.backend).toBe('pglite');
    expect(result.operations.map(({ key }) => key)).toEqual(
      CORE_FIELD_TRANSITIONS_CASES.map(({ key }) => key)
    );
    for (const operation of result.operations) {
      expect(operation).toMatchObject({ count: 2, errors: 0 });
      expect(operation.samplesMs).toHaveLength(2);
      expect(operation.samplesMs.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    }
    for (const key of [
      'core:UpdateFieldCommand/text-to-number-mixed-64',
      'core:UpdateFieldCommand/number-to-text-formatted-64',
      'core:UpdateFieldCommand/dependent-formula-expression-64',
    ]) {
      expect(result.operations.find((operation) => operation.key === key)).toMatchObject({
        rowsWritten: 128,
      });
    }
    expect(
      result.operations.find(
        ({ key }) => key === 'core:UpdateFieldCommand/reject-nonstring-formula-expression'
      )
    ).toMatchObject({ count: 2, rowsWritten: 0, errors: 0 });
    expect(result.operations.filter(({ kind }) => kind === 'flush-computed')).toHaveLength(3);
    expect(result.dimensions).toMatchObject({
      samples: 2,
      warmup: 1,
      caseIdentityVersion: 1,
      populatedRows: 64,
      fixtureValueCounts: { validNumericStrings: 40, nulls: 8, invalidStrings: 16 },
      dependentFormulas: ['COUNTA(Convertible) * multiplier', 'Presence + Guard'],
      formulaMultipliers: [1, 2],
      expectedRejectedOperation: {
        key: 'core:UpdateFieldCommand/reject-nonstring-formula-expression',
        code: 'validation.invalid',
        message: 'Invalid FormulaExpression',
        tags: ['validation'],
      },
      setupTiming: 'excluded',
      computedDrainTiming: 'measured-separately-from-triggering-command',
      persistedReadbackTiming: 'excluded',
      sampleIsolation: {
        fixturePerRound:
          'fresh registered base and generated table/field/record identities with deterministic 64-row content',
        cleanup: 'cleanupBenchBase removes only the round-owned registered base',
        runtimeReuse: 'one runtime across rounds; no fixture state is reused',
      },
      excludedCapabilities: ['undo', 'redo', 'realtime'],
    });
  }, 120_000);

  it('requires valid sample counts and an explicit PostgreSQL connection', async () => {
    await expect(
      runCoreFieldTransitionsBench({ backend: 'pglite', samples: 0, warmup: 0 })
    ).rejects.toThrow('samples must be a positive integer');
    await expect(
      runCoreFieldTransitionsBench({ backend: 'pglite', samples: 1, warmup: -1 })
    ).rejects.toThrow('warmup must be a non-negative integer');
    await expect(
      runCoreFieldTransitionsBench({ backend: 'postgres', samples: 1, warmup: 0 })
    ).rejects.toThrow('connectionString is required for the postgres backend');
  });
});
