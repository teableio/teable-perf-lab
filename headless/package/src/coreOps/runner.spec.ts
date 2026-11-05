import { describe, expect, it } from 'vitest';

import { CORE_OPS_CASES } from './cases';
import { runCoreOpsBench } from './runner';

describe('runCoreOpsBench', () => {
  it('converts a populated field while preserving values and completes every supported Core operation', async () => {
    const result = await runCoreOpsBench({
      backend: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(result.correctness, result.errors.join('\n')).toBe('pass');
    expect(result.errors).toEqual([]);
    expect(result.caseId).toBe('headless-core-operations-v2');
    expect(result.operations.map(({ key }) => key)).toEqual(CORE_OPS_CASES.map(({ key }) => key));
    expect(result.operations.every(({ count, errors }) => count === 1 && errors === 0)).toBe(true);

    const conversion = result.operations.find(
      ({ key }) => key === 'UpdateFieldCommand(convert-populated)'
    );
    expect(conversion).toMatchObject({
      count: 1,
      rowsWritten: 6,
      errors: 0,
    });
    expect(
      (result.dimensions['unsupported'] as ReadonlyArray<string>).some((item) =>
        item.startsWith('base-delete:')
      )
    ).toBe(true);
  }, 120_000);
});
