import type { BenchOperationMeasurement } from '../runner/BenchRunner';

export type CoreFanoutDeletionBenchCase = {
  /** Stable report key for one real Core command or runtime computed drain. */
  readonly key: string;
  readonly identity: string;
  readonly kind: BenchOperationMeasurement['kind'];
};

/**
 * Command execution and computed draining are intentionally separate measurements.
 * Readback assertions are not represented here because they are outside operation timing.
 */
export const CORE_FANOUT_DELETION_CASES = [
  {
    key: 'core:UpdateRecordCommand/linked-source-before-delete',
    identity: 'UpdateRecordCommand',
    kind: 'write-update',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/linked-source-update-fanout',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
  {
    key: 'core:DeleteRecordsCommand/linked-source',
    identity: 'DeleteRecordsCommand',
    kind: 'write-delete',
  },
  {
    key: 'core:IHeadlessRuntime.flushComputed/linked-source-delete-fanout',
    identity: 'IHeadlessRuntime.flushComputed',
    kind: 'flush-computed',
  },
] as const satisfies ReadonlyArray<CoreFanoutDeletionBenchCase>;

export type CoreFanoutDeletionBenchCaseKey = (typeof CORE_FANOUT_DELETION_CASES)[number]['key'];

export const CORE_FANOUT_DELETION_CI_FANOUT = 1_000;
export const CORE_FANOUT_DELETION_LARGE_FANOUT = 10_000;
export const CORE_FANOUT_DELETION_CASE_ID_VERSION = 1;
export const CORE_FANOUT_DELETION_UNAFFECTED_ROWS = 3;

export function coreFanoutDeletionCaseId(fanout: number): string {
  return `headless-core-fanout-deletion-v${CORE_FANOUT_DELETION_CASE_ID_VERSION}-${fanout}f-${CORE_FANOUT_DELETION_UNAFFECTED_ROWS}u`;
}
