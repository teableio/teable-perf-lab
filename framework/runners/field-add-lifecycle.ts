// The field-add family's name for the shared measured-create lifecycle.
//
// The body lives in measured-create-lifecycle.ts; this file keeps the
// family-named types and functions the field-add runners import. Its scope note
// used to say a broader abstraction should wait for a family that breaks its
// assumptions — the duplicate family instead grew an identical copy of the same
// driver, so the two were merged rather than kept in sync by hand.

import type {
  MeasuredCreateBuildResultArgs,
  MeasuredCreatePrepareArgs,
  MeasuredCreateSpec,
} from "./measured-create-lifecycle";
import {
  runMeasuredCreateLifecycle,
  seedMeasuredCreateLifecycle,
} from "./measured-create-lifecycle";

export type FieldAddLifecyclePrepareArgs<TConfig> =
  MeasuredCreatePrepareArgs<TConfig>;

export type FieldAddLifecycleBuildResultArgs<
  TConfig,
  TFixture,
  TSeedReady,
  TPrimary,
> = MeasuredCreateBuildResultArgs<TConfig, TFixture, TSeedReady, TPrimary>;

export type FieldAddLifecycleSpec<TConfig, TFixture, TSeedReady, TPrimary> =
  MeasuredCreateSpec<TConfig, TFixture, TSeedReady, TPrimary>;

export const seedFieldAddLifecycle = seedMeasuredCreateLifecycle;
export const runFieldAddLifecycle = runMeasuredCreateLifecycle;
