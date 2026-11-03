import { describe, expect, it } from 'vitest';

import { CORE_QUERY_CASES } from './cases';
import { runCoreQueryCasesBench } from './runner';

describe('runCoreQueryCasesBench', () => {
  it('covers exact query boundaries with complete cursor paging and persisted oracles', async () => {
    const result = await runCoreQueryCasesBench({
      backend: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(result.correctness, result.errors.join('\n')).toBe('pass');
    expect(result.errors).toEqual([]);
    expect(result.operations.map(({ key }) => key)).toEqual(CORE_QUERY_CASES.map(({ key }) => key));
    expect(result.operations.every(({ count, errors }) => count === 1 && errors === 0)).toBe(true);
    expect(
      result.operations.find(({ key }) => key === 'ListTableRecordsQuery(filter-empty)')
    ).toMatchObject({ rowsReturned: 0, errors: 0 });
    expect(
      result.operations.find(({ key }) => key === 'ListTableRecordsQuery(cursor-complete)')
    ).toMatchObject({ rowsRead: 9, rowsReturned: 9, errors: 0 });
    expect(
      result.operations.find(({ key }) => key === 'CountTableRecordsQuery(selective)')
    ).toMatchObject({ rowsRead: 2, rowsReturned: 1, errors: 0 });
    expect(result.dimensions).toMatchObject({
      fixtureRows: 9,
      cursorPageSize: 3,
      cleanup: 'benchmark-owned base removed after every warmup and measured round',
    });
    expect(result.dimensions['unsupported']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('ids-only sweep:'),
        expect.stringContaining('record-index lookup:'),
      ])
    );
  }, 120_000);
});
