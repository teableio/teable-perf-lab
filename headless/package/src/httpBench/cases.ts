import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type HttpBenchCase = {
  readonly key: `${'GET' | 'POST' | 'DELETE'} ${string}`;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly route: string;
  readonly expectedStatus: number;
  readonly kind: BenchOperationMeasurement['kind'];
};

/**
 * Stable operation catalogue for the loopback HTTP benchmark. Every key names
 * the actual method and route whose complete response is timed.
 */
export const HTTP_BENCH_CASES = [
  {
    key: 'POST /bases/create',
    method: 'POST',
    route: '/bases/create',
    expectedStatus: 201,
    kind: 'write-create',
  },
  {
    key: 'GET /bases/list',
    method: 'GET',
    route: '/bases/list',
    expectedStatus: 200,
    kind: 'query-core',
  },
  {
    key: 'POST /tables/create',
    method: 'POST',
    route: '/tables/create',
    expectedStatus: 201,
    kind: 'write-create',
  },
  {
    key: 'GET /tables/list',
    method: 'GET',
    route: '/tables/list',
    expectedStatus: 200,
    kind: 'query-core',
  },
  {
    key: 'POST /tables/rename',
    method: 'POST',
    route: '/tables/rename',
    expectedStatus: 200,
    kind: 'write-update',
  },
  {
    key: 'POST /tables/createField',
    method: 'POST',
    route: '/tables/createField',
    expectedStatus: 200,
    kind: 'write-create',
  },
  {
    key: 'POST /tables/updateField',
    method: 'POST',
    route: '/tables/updateField',
    expectedStatus: 200,
    kind: 'write-update',
  },
  {
    key: 'POST /tables/createRecord',
    method: 'POST',
    route: '/tables/createRecord',
    expectedStatus: 201,
    kind: 'write-create',
  },
  {
    key: 'POST /tables/createRecords',
    method: 'POST',
    route: '/tables/createRecords',
    expectedStatus: 201,
    kind: 'write-create',
  },
  {
    key: 'GET /tables/getRecord',
    method: 'GET',
    route: '/tables/getRecord',
    expectedStatus: 200,
    kind: 'query-core',
  },
  {
    key: 'GET /tables/listRecords?page',
    method: 'GET',
    route: '/tables/listRecords',
    expectedStatus: 200,
    kind: 'query-core',
  },
  {
    key: 'GET /tables/listRecords?filter+sort',
    method: 'GET',
    route: '/tables/listRecords',
    expectedStatus: 200,
    kind: 'query-core',
  },
  {
    key: 'POST /tables/updateRecord',
    method: 'POST',
    route: '/tables/updateRecord',
    expectedStatus: 200,
    kind: 'write-update',
  },
  {
    key: 'POST /tables/updateRecords',
    method: 'POST',
    route: '/tables/updateRecords',
    expectedStatus: 200,
    kind: 'write-update',
  },
  {
    key: 'POST /tables/importRecords',
    method: 'POST',
    route: '/tables/importRecords',
    expectedStatus: 200,
    kind: 'write-create',
  },
  {
    key: 'POST /runtime/flushComputed',
    method: 'POST',
    route: '/runtime/flushComputed',
    expectedStatus: 200,
    kind: 'flush-computed',
  },
  {
    key: 'POST /tables/importCsv',
    method: 'POST',
    route: '/tables/importCsv',
    expectedStatus: 201,
    kind: 'write-create',
  },
  {
    key: 'DELETE /tables/deleteRecords',
    method: 'DELETE',
    route: '/tables/deleteRecords',
    expectedStatus: 200,
    kind: 'write-delete',
  },
  {
    key: 'DELETE /tables/deleteField',
    method: 'DELETE',
    route: '/tables/deleteField',
    expectedStatus: 200,
    kind: 'write-delete',
  },
  {
    key: 'DELETE /tables/delete',
    method: 'DELETE',
    route: '/tables/delete',
    expectedStatus: 200,
    kind: 'write-delete',
  },
] as const satisfies ReadonlyArray<HttpBenchCase>;

export type HttpBenchCaseKey = (typeof HTTP_BENCH_CASES)[number]['key'];

export const HTTP_BENCH_CASE_BY_KEY: ReadonlyMap<HttpBenchCaseKey, HttpBenchCase> = new Map(
  HTTP_BENCH_CASES.map((benchCase) => [benchCase.key, benchCase])
);
