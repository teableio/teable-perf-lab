import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreRelationCasesBenchCase = {
  /** Stable report key for one real Core command or computed drain. */
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

/**
 * Stable operation catalogue for bidirectional relation semantics. Command
 * latency, computed draining, and persisted correctness readback are kept
 * separate so no operation hides unrelated work in its sample.
 */
export const CORE_RELATION_CASES = [
  {
    key: 'core:CreateFieldCommand/one-one-bidirectional',
    identity: 'CreateFieldCommand',
    kind: 'write-create',
  },
  {
    key: 'core:CreateFieldCommand/many-one-bidirectional',
    identity: 'CreateFieldCommand',
    kind: 'write-create',
  },
  {
    key: 'core:CreateFieldCommand/child-parent-lookup',
    identity: 'CreateFieldCommand',
    kind: 'write-create',
  },
  {
    key: 'core:CreateFieldCommand/child-parent-rollup',
    identity: 'CreateFieldCommand',
    kind: 'write-create',
  },
  {
    key: 'core:CreateFieldCommand/parent-children-lookup',
    identity: 'CreateFieldCommand',
    kind: 'write-create',
  },
  {
    key: 'core:CreateFieldCommand/parent-children-rollup',
    identity: 'CreateFieldCommand',
    kind: 'write-create',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/relation-schema',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/one-one-assign',
    identity: 'UpdateRecordCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/one-one-assign',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/one-one-reassign',
    identity: 'UpdateRecordCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/one-one-reassign',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordCommand/one-one-clear',
    identity: 'UpdateRecordCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/one-one-clear',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordsCommand/many-one-fanout-assign',
    identity: 'UpdateRecordsCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/many-one-fanout-assign',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordsCommand/many-one-reassign',
    identity: 'UpdateRecordsCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/many-one-reassign',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:UpdateRecordsCommand/many-one-clear',
    identity: 'UpdateRecordsCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/many-one-clear',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:DeleteRecordsCommand/linked-parent-target',
    identity: 'DeleteRecordsCommand',
    kind: 'write-delete',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/linked-parent-target-delete',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
] as const satisfies ReadonlyArray<CoreRelationCasesBenchCase>;

export type CoreRelationCasesBenchCaseKey = (typeof CORE_RELATION_CASES)[number]['key'];
