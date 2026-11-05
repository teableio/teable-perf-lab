import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreOpsBenchCase = {
  /** Stable report identity naming the exact Core command or query being executed. */
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

/**
 * Stable catalogue for the direct Core operations benchmark. Variants in
 * parentheses are intentionally separate measurements even when they use the
 * same command/query class with different semantics.
 */
export const CORE_OPS_CASES = [
  { key: 'CreateBaseCommand', identity: 'CreateBaseCommand', kind: 'write-create' },
  { key: 'ListBasesQuery', identity: 'ListBasesQuery', kind: 'query-core' },
  { key: 'CreateTableCommand', identity: 'CreateTableCommand', kind: 'write-create' },
  { key: 'ListTablesQuery', identity: 'ListTablesQuery', kind: 'query-core' },
  { key: 'RenameTableCommand', identity: 'RenameTableCommand', kind: 'write-update' },
  { key: 'CreateFieldCommand', identity: 'CreateFieldCommand', kind: 'write-create' },
  { key: 'ListFieldsQuery', identity: 'ListFieldsQuery', kind: 'query-core' },
  {
    key: 'UpdateFieldCommand(rename)',
    identity: 'UpdateFieldCommand',
    kind: 'write-update',
  },
  {
    key: 'CreateRecordsStreamCommand',
    identity: 'CreateRecordsStreamCommand',
    kind: 'write-create',
  },
  {
    key: 'UpdateFieldCommand(convert-populated)',
    identity: 'UpdateFieldCommand',
    kind: 'write-update',
  },
  { key: 'PasteCommand', identity: 'PasteCommand', kind: 'write-update' },
  { key: 'ClearCommand', identity: 'ClearCommand', kind: 'write-update' },
  { key: 'UpsertRecordsCommand', identity: 'UpsertRecordsCommand', kind: 'write-update' },
  { key: 'DeleteByRangeCommand', identity: 'DeleteByRangeCommand', kind: 'write-delete' },
  {
    key: 'ListTableRecordsQuery(page)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(filter)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(sort)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'ListTableRecordsQuery(search)',
    identity: 'ListTableRecordsQuery',
    kind: 'query-core',
  },
  {
    key: 'AggregateTableRecordsQuery',
    identity: 'AggregateTableRecordsQuery',
    kind: 'query-core',
  },
  { key: 'ImportCsvCommand', identity: 'ImportCsvCommand', kind: 'write-create' },
  { key: 'ImportExcelCommand', identity: 'ImportExcelCommand', kind: 'write-create' },
  { key: 'DeleteFieldCommand', identity: 'DeleteFieldCommand', kind: 'write-delete' },
  { key: 'DeleteTableCommand', identity: 'DeleteTableCommand', kind: 'write-delete' },
] as const satisfies ReadonlyArray<CoreOpsBenchCase>;

export type CoreOpsBenchCaseKey = (typeof CORE_OPS_CASES)[number]['key'];
