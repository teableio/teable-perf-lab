import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreViewsBenchCase = {
  /** Stable report identity naming the exact Core operation being executed. */
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

/**
 * Public Core View commands and queries exercised by the standalone lifecycle
 * track. Independent persistence readbacks stay outside each timed interval.
 */
export const CORE_VIEWS_CASES = [
  { key: 'CreateViewCommand', identity: 'CreateViewCommand', kind: 'write-create' },
  { key: 'ListViewsQuery', identity: 'ListViewsQuery', kind: 'query-core' },
  { key: 'RenameViewCommand', identity: 'RenameViewCommand', kind: 'write-update' },
  {
    key: 'UpdateViewDescriptionCommand',
    identity: 'UpdateViewDescriptionCommand',
    kind: 'write-update',
  },
  {
    key: 'UpdateViewFilterCommand',
    identity: 'UpdateViewFilterCommand',
    kind: 'write-update',
  },
  { key: 'UpdateViewSortCommand', identity: 'UpdateViewSortCommand', kind: 'write-update' },
  {
    key: 'ListTableRecordsQuery(view-filter-sort)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  { key: 'UpdateViewGroupCommand', identity: 'UpdateViewGroupCommand', kind: 'write-update' },
  {
    key: 'UpdateViewColumnMetaCommand',
    identity: 'UpdateViewColumnMetaCommand',
    kind: 'write-update',
  },
  { key: 'GetViewQuery', identity: 'GetViewQuery', kind: 'query-core' },
  { key: 'DuplicateViewCommand', identity: 'DuplicateViewCommand', kind: 'write-create' },
  { key: 'DeleteViewCommand', identity: 'DeleteViewCommand', kind: 'write-delete' },
] as const satisfies ReadonlyArray<CoreViewsBenchCase>;

export type CoreViewsBenchCaseKey = (typeof CORE_VIEWS_CASES)[number]['key'];
