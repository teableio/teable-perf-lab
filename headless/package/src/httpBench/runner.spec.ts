import { afterEach, describe, expect, it, vi } from 'vitest';

import { HTTP_BENCH_CASES, runHttpBench } from './runner';

const toUrl = (resource: Parameters<typeof fetch>[0]): URL =>
  new URL(
    resource instanceof URL ? resource.href : typeof resource === 'string' ? resource : resource.url
  );

afterEach(() => vi.restoreAllMocks());

describe('runHttpBench', () => {
  it('publishes one deterministic case for each measured method and route', () => {
    expect(HTTP_BENCH_CASES.map(({ key }) => key)).toEqual([
      'POST /bases/create',
      'GET /bases/list',
      'POST /tables/create',
      'GET /tables/list',
      'POST /tables/rename',
      'POST /tables/createField',
      'POST /tables/updateField',
      'POST /tables/createRecord',
      'POST /tables/createRecords',
      'GET /tables/getRecord',
      'GET /tables/listRecords?page',
      'GET /tables/listRecords?filter+sort',
      'POST /tables/updateRecord',
      'POST /tables/updateRecords',
      'POST /tables/importRecords',
      'POST /runtime/flushComputed',
      'POST /tables/importCsv',
      'DELETE /tables/deleteRecords',
      'DELETE /tables/deleteField',
      'DELETE /tables/delete',
    ]);
    expect(new Set(HTTP_BENCH_CASES.map(({ key }) => key)).size).toBe(HTTP_BENCH_CASES.length);
  });

  it('rejects sample counts that cannot produce measurements', async () => {
    await expect(runHttpBench({ backend: 'pglite', samples: 0, warmup: 0 })).rejects.toThrow(
      /samples must be a positive integer/
    );
    await expect(runHttpBench({ backend: 'pglite', samples: 1, warmup: -1 })).rejects.toThrow(
      /warmup must be a non-negative integer/
    );
  });

  it('executes CRUD, CSV, filtering, pagination, and computed work through loopback TCP HTTP', async () => {
    const result = await runHttpBench({ backend: 'pglite', samples: 1, warmup: 0 });

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.correctness).toBe('pass');
    expect(result.backend).toBe('pglite');
    expect(result.caseId).toBe('headless-http-crud-csv-v2');
    expect(result.operations.map(({ key }) => key)).toEqual(HTTP_BENCH_CASES.map(({ key }) => key));
    expect(
      result.operations.every(
        ({ count, samplesMs, errors }) =>
          count === 1 && samplesMs.length === 1 && samplesMs[0]! >= 0 && errors === 0
      )
    ).toBe(true);
    expect(result.operations.find(({ key }) => key === 'POST /tables/createRecords')).toMatchObject(
      { rowsWritten: 12 }
    );
    expect(result.operations.find(({ key }) => key === 'POST /tables/importRecords')).toMatchObject(
      { rowsWritten: 3 }
    );
    expect(result.operations.find(({ key }) => key === 'POST /tables/importCsv')).toMatchObject({
      rowsWritten: 3,
    });
    expect(result.dimensions).toMatchObject({
      transport: 'loopback-tcp-http',
      responseValidation: 'status-and-json-envelope',
      persistenceValidation: 'untimed-http-readback',
      unsupportedOperations: ['base-update', 'base-delete'],
    });
  }, 120_000);

  it.each([
    {
      fault: 'the page offset is ignored',
      rewrite: (url: URL) => {
        if (url.pathname === '/tables/listRecords' && url.searchParams.get('offset') === '2') {
          url.searchParams.set('offset', '0');
        }
      },
      expectedError: /Offset page ordered records/,
    },
    {
      fault: 'the record filter is ignored',
      rewrite: (url: URL) => {
        if (url.pathname === '/tables/listRecords' && url.searchParams.has('filter')) {
          url.searchParams.delete('filter');
        }
      },
      expectedError: /Filtered page total/,
    },
  ])(
    'fails correctness when $fault',
    async ({ rewrite, expectedError }) => {
      const fetchThrough = globalThis.fetch.bind(globalThis);
      vi.spyOn(globalThis, 'fetch').mockImplementation((resource, options) => {
        const url = toUrl(resource);
        rewrite(url);
        return fetchThrough(url, options);
      });

      const result = await runHttpBench({ backend: 'pglite', samples: 1, warmup: 0 });

      expect(result.correctness).toBe('fail');
      expect(result.errors.join('\n')).toMatch(expectedError);
    },
    120_000
  );

  it('fails correctness when an imported numeric value is corrupted at the HTTP seam', async () => {
    const fetchThrough = globalThis.fetch.bind(globalThis);
    let importedTableId: string | undefined;
    let corrupted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, options) => {
      const url = toUrl(resource);
      const response = await fetchThrough(resource, options);
      if (url.pathname === '/tables/importCsv') {
        const payload = (await response.clone().json()) as {
          data?: { table?: { id?: string } };
        };
        importedTableId = payload.data?.table?.id;
        return response;
      }
      if (
        importedTableId &&
        url.pathname === '/tables/listRecords' &&
        url.searchParams.get('tableId') === importedTableId
      ) {
        const payload = (await response.json()) as {
          data?: { records?: Array<{ fields: Record<string, unknown> }> };
        };
        const fields = payload.data?.records?.[0]?.fields;
        const amount =
          fields && Object.entries(fields).find(([, value]) => typeof value === 'number');
        if (fields && amount) {
          fields[amount[0]] = 999;
          corrupted = true;
        }
        return new Response(JSON.stringify(payload), {
          status: response.status,
          headers: new Headers([['content-type', 'application/json']]),
        });
      }
      return response;
    });

    const result = await runHttpBench({ backend: 'pglite', samples: 1, warmup: 0 });

    expect(corrupted).toBe(true);
    expect(result.correctness).toBe('fail');
    expect(result.errors.join('\n')).toMatch(/New-table CSV persisted values/);
  }, 120_000);

  it('fails correctness when updateField echoes a description that was not persisted', async () => {
    const fetchThrough = globalThis.fetch.bind(globalThis);
    let omittedDescription = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, options) => {
      const url = toUrl(resource);
      if (url.pathname !== '/tables/updateField' || typeof options?.body !== 'string') {
        return fetchThrough(resource, options);
      }
      const body = JSON.parse(options.body) as {
        fieldId: string;
        field: { name: string; description?: string };
      };
      const description = body.field.description;
      delete body.field.description;
      omittedDescription = true;
      const response = await fetchThrough(resource, { ...options, body: JSON.stringify(body) });
      const payload = (await response.json()) as {
        data: { table: { fields: Array<{ id: string; description?: string }> } };
      };
      const updated = payload.data.table.fields.find(({ id }) => id === body.fieldId);
      if (updated) updated.description = description;
      return new Response(JSON.stringify(payload), {
        status: response.status,
        headers: new Headers([['content-type', 'application/json']]),
      });
    });

    const result = await runHttpBench({ backend: 'pglite', samples: 1, warmup: 0 });

    expect(omittedDescription).toBe(true);
    expect(result.correctness).toBe('fail');
    expect(result.errors.join('\n')).toMatch(/Persisted updated field description/);
  }, 120_000);
});
