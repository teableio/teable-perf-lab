import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreVolumeBenchCase = {
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

export const CORE_VOLUME_CASES = [
  {
    key: 'core:CreateRecordsStreamCommand/volume-generator',
    identity: 'CreateRecordsStreamCommand.createFromIterable',
    kind: 'write-create',
  },
  {
    key: 'core:ListTableRecordsQuery/selective-segment',
    identity: 'ListTableRecordsQuery(filter=segment:update)',
    kind: 'query-core',
  },
  {
    key: 'core:CountTableRecordsQuery/selective-segment',
    identity: 'CountTableRecordsQuery(filter=segment:update)',
    kind: 'query-core',
  },
  {
    key: 'core:UpdateRecordsCommand/filter-bulk',
    identity: 'UpdateRecordsCommand(filter=segment:update)',
    kind: 'write-update',
  },
  {
    key: 'core:DeleteRecordsCommand/id-bulk',
    identity: 'DeleteRecordsCommand(recordIds=segment:delete)',
    kind: 'write-delete',
  },
] as const satisfies ReadonlyArray<CoreVolumeBenchCase>;

export type CoreVolumeBenchCaseKey = (typeof CORE_VOLUME_CASES)[number]['key'];
