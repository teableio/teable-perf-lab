import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreQueryCasesBenchCase = {
  /** Stable report identity naming the exact public Core query being executed. */
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

/**
 * Stable catalogue for query-boundary coverage that is intentionally separate
 * from the broad Core operations track.
 */
export const CORE_QUERY_CASES = [
  {
    key: 'ListTableRecordsQuery(filter-empty)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(filter-selective)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(cursor-complete)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(group-metadata)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(search-metadata)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'CountTableRecordsQuery(selective)',
    identity: 'CountTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'AggregateTableRecordsQuery(grouped)',
    identity: 'AggregateTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(view-defaults)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
] as const satisfies ReadonlyArray<CoreQueryCasesBenchCase>;

export type CoreQueryCasesBenchCaseKey = (typeof CORE_QUERY_CASES)[number]['key'];
