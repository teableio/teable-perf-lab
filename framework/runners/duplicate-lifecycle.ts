// The duplicate family's name for the shared measured-create lifecycle.
//
// The body lives in measured-create-lifecycle.ts; this file keeps the
// family-named types and functions the duplicate runners import. Its scope note
// used to call duplicate-base the "deferred second member" that would prove the
// shape generic. duplicate-base, record-duplicate-single, and
// selection-duplicate all ride it now, and the field-add family had grown an
// identical copy of the same driver, so the two were merged.
//
// Cleanup for this family is Class C drop-or-keep: the measured operation
// creates a brand-new duplicate entity, so cleanup always drops that copy and
// additionally drops the source unless it is a reusable cached seed. That
// decision lives in each runner's cleanup, which the shared driver delegates to.

import type {
  MeasuredCreateBuildResultArgs,
  MeasuredCreatePrepareArgs,
  MeasuredCreateSpec,
} from "./measured-create-lifecycle";
import {
  runMeasuredCreateLifecycle,
  seedMeasuredCreateLifecycle,
} from "./measured-create-lifecycle";

export type DuplicateLifecyclePrepareArgs<TConfig> =
  MeasuredCreatePrepareArgs<TConfig>;

export type DuplicateLifecycleBuildResultArgs<
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
> = MeasuredCreateBuildResultArgs<TConfig, TFixture, TSeedReady, TPrimary>;

export type DuplicateLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary> =
  MeasuredCreateSpec<TConfig, TFixture, TSeedReady, TPrimary>;

export const seedDuplicateLifecycle = seedMeasuredCreateLifecycle;
export const runDuplicateLifecycle = runMeasuredCreateLifecycle;
