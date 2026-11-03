import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreExtraBenchCase = {
  /** Stable report identity naming the exact Core command or query being executed. */
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

/** Public Core operations intentionally measured one command/query at a time. */
export const CORE_EXTRA_CASES = [
  { key: 'GetTableByIdQuery', identity: 'GetTableByIdQuery', kind: 'query-core' },
  { key: 'CreateTablesCommand', identity: 'CreateTablesCommand', kind: 'write-create' },
  {
    key: 'UpdateTablePropertiesCommand',
    identity: 'UpdateTablePropertiesCommand',
    kind: 'write-update',
  },
  { key: 'CreateRecordCommand', identity: 'CreateRecordCommand', kind: 'write-create' },
  { key: 'GetRecordByIdQuery', identity: 'GetRecordByIdQuery', kind: 'query-core' },
  { key: 'DuplicateRecordCommand', identity: 'DuplicateRecordCommand', kind: 'write-create' },
  { key: 'CreateFieldsCommand', identity: 'CreateFieldsCommand', kind: 'write-create' },
  { key: 'DeleteFieldsCommand', identity: 'DeleteFieldsCommand', kind: 'write-delete' },
  {
    key: 'DuplicateFieldCommand/with-values',
    identity: 'DuplicateFieldCommand(includeRecordValues=true)',
    kind: 'write-create',
  },
  {
    key: 'DuplicateFieldCommand/schema-only',
    identity: 'DuplicateFieldCommand(includeRecordValues=false)',
    kind: 'write-create',
  },
  { key: 'DuplicateTableCommand', identity: 'DuplicateTableCommand', kind: 'write-create' },
] as const satisfies ReadonlyArray<CoreExtraBenchCase>;

export type CoreExtraBenchCaseKey = (typeof CORE_EXTRA_CASES)[number]['key'];
