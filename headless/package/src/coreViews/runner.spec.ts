import { describe, expect, it } from 'vitest';

import { CORE_VIEWS_CASES } from './cases';
import { runCoreViewsBench } from './runner';

describe('runCoreViewsBench', () => {
  it('persists the supported Core View lifecycle and query configuration on real PGlite', async () => {
    const result = await runCoreViewsBench({
      backend: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(result.caseId).toBe('headless-core-views-v2');
    expect(result.correctness, result.errors.join('\n')).toBe('pass');
    expect(result.errors).toEqual([]);
    expect(result.operations.map(({ key }) => key)).toEqual(CORE_VIEWS_CASES.map(({ key }) => key));
    expect(result.operations.every(({ count, errors }) => count === 1 && errors === 0)).toBe(true);
    expect(
      result.operations
        .filter(({ kind }) => kind !== 'query-core')
        .every(({ rowsWritten }) => rowsWritten === 1)
    ).toBe(true);
    expect(result.operations.find(({ key }) => key === 'ListViewsQuery')).toMatchObject({
      count: 1,
      rowsRead: 2,
      rowsReturned: 2,
      errors: 0,
    });
    expect(
      result.operations.find(({ key }) => key === 'ListTableRecordsQuery(view-filter-sort)')
    ).toMatchObject({
      count: 1,
      rowsRead: 3,
      rowsReturned: 3,
      errors: 0,
    });
    expect(result.operations.find(({ key }) => key === 'GetViewQuery')).toMatchObject({
      count: 1,
      rowsRead: 1,
      rowsReturned: 1,
      errors: 0,
    });
    expect(result.dimensions['benchmarkedCommands']).toEqual(
      CORE_VIEWS_CASES.filter(({ identity }) => identity.endsWith('Command')).map(
        ({ identity }) => identity
      )
    );
    expect(result.dimensions['benchmarkedQueries']).toEqual([
      'ListViewsQuery',
      'ListTableRecordsQuery',
      'GetViewQuery',
    ]);
    expect(result.dimensions['absentCommands']).toEqual([
      'UpdateViewCommand: no generic public Core command; use granular commands',
      'RestoreViewCommand: no public Core command',
      'UpdateViewTypeCommand: no public Core command',
    ]);
    expect(result.dimensions['absentQueries']).toEqual([
      'GetViewRecordsQuery: no dedicated public Core query; use ListTableRecordsQuery with viewId',
    ]);
    expect(result.dimensions['caseIdentityVersion']).toBe(2);
    expect(result.dimensions['viewRecordReadModel']).toBe(
      'ListTableRecordsQuery(viewId) applies the persisted View filter and sort'
    );
    expect(result.dimensions['unsupported']).toContain(
      'dedicated view-record query: no public GetViewRecordsQuery; use ListTableRecordsQuery with viewId'
    );
    expect(result.dimensions['isolation']).toBe(
      'fresh-memory-runtime-and-fresh-owned-base-table-per-round'
    );
  }, 120_000);
});
