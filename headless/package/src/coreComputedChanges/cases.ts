import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreComputedChangesBenchCase = {
  /** Stable report key for one real Core command or runtime computed drain. */
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

/**
 * Stable operation catalogue for computed schema and linked-record changes.
 * Command execution and computed draining stay separate so reports do not hide
 * queue settlement inside mutation latency.
 */
export const CORE_COMPUTED_CHANGES_CASES = [
  {
    key: 'core:CreateFieldCommand/formula-populated',
    identity: 'CreateFieldCommand',
    kind: 'write-create',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/formula-create',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateFieldCommand/formula-expression',
    identity: 'UpdateFieldCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/formula-expression',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/linked-source-update',
    identity: 'UpdateRecordCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/linked-source-update',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/link-unlink',
    identity: 'UpdateRecordCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/link-unlink',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/link-relink',
    identity: 'UpdateRecordCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/link-relink',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
] as const satisfies ReadonlyArray<CoreComputedChangesBenchCase>;

export type CoreComputedChangesBenchCaseKey = (typeof CORE_COMPUTED_CHANGES_CASES)[number]['key'];
