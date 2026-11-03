import { describe, expect, it } from 'vitest';

import { CORE_EXTRA_CASES } from './cases';
import { runCoreExtraBench } from './runner';

describe('runCoreExtraBench', () => {
  it('rejects sample counts that cannot produce measurements', async () => {
    await expect(runCoreExtraBench({ backend: 'pglite', samples: 0, warmup: 0 })).rejects.toThrow(
      /samples must be a positive integer/
    );
    await expect(runCoreExtraBench({ backend: 'pglite', samples: 1, warmup: -1 })).rejects.toThrow(
      /warmup must be a non-negative integer/
    );
  });

  it('executes expanded Core reads, schema writes, and duplicate variants on real PGlite', async () => {
    const result = await runCoreExtraBench({
      backend: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(result.correctness, result.errors.join('\n')).toBe('pass');
    expect(result.errors).toEqual([]);
    expect(result.caseId).toBe('headless-core-extra-operations-v2');
    expect(result.operations.map(({ key }) => key)).toEqual(CORE_EXTRA_CASES.map(({ key }) => key));
    expect(result.operations.every(({ count, errors }) => count === 1 && errors === 0)).toBe(true);
    expect(result.operations.find(({ key }) => key === 'CreateTablesCommand')).toMatchObject({
      rowsWritten: 3,
    });
    expect(
      result.operations.find(({ key }) => key === 'UpdateTablePropertiesCommand')
    ).toMatchObject({ rowsWritten: 1 });
    expect(result.operations.find(({ key }) => key === 'DuplicateRecordCommand')).toMatchObject({
      rowsRead: 1,
      rowsWritten: 1,
    });
    expect(result.operations.find(({ key }) => key === 'CreateFieldsCommand')).toMatchObject({
      rowsWritten: 2,
    });
    expect(result.operations.find(({ key }) => key === 'DeleteFieldsCommand')).toMatchObject({
      rowsWritten: 2,
    });
    expect(
      result.operations.find(({ key }) => key === 'DuplicateFieldCommand/with-values')
    ).toMatchObject({ rowsRead: 2, rowsWritten: 3 });
    expect(
      result.operations.find(({ key }) => key === 'DuplicateFieldCommand/schema-only')
    ).toMatchObject({ rowsRead: 1, rowsWritten: 1 });
    expect(result.operations.find(({ key }) => key === 'DuplicateTableCommand')).toMatchObject({
      rowsRead: 2,
      rowsWritten: 3,
    });
    expect(result.dimensions['capabilities']).toEqual(
      expect.arrayContaining([
        'table-bulk-create-schema-only-and-seeded',
        'table-properties-update',
        'record-singular-create-get-by-id-and-duplicate',
        'field-duplicate-with-values-and-schema-only',
        'table-duplicate-with-records',
      ])
    );
    expect(result.dimensions['operationIdentities']).toMatchObject({
      CreateTablesCommand: 'CreateTablesCommand',
      UpdateTablePropertiesCommand: 'UpdateTablePropertiesCommand',
      DuplicateRecordCommand: 'DuplicateRecordCommand',
      ['DuplicateFieldCommand/with-values']: 'DuplicateFieldCommand(includeRecordValues=true)',
      ['DuplicateFieldCommand/schema-only']: 'DuplicateFieldCommand(includeRecordValues=false)',
    });
    expect(result.dimensions['unsupportedPublicOperations']).toEqual([]);
    expect(result.dimensions['excludedCapabilities']).toEqual(['undo', 'redo', 'realtime']);
  }, 120_000);
});
