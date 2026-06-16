export type TraceShapeRef = {
  traceId: string;
  stepId: string;
};

// PRODUCER CONTRACT (enforced by convention in the runners, relied on here):
// a trailing numeric / `sample-N` token in a stepId MUST denote an
// interchangeable repeat of the same operation (iteration, batch, sample).
// Structurally distinct steps MUST be told apart by a non-numeric identifier
// (a field/keyword name), never a bare positional index — otherwise they
// collapse to one shape and a saved trace falsely "covers" another step's
// Jaeger 404. See `seedBuild:createFormulaField:${formulaName(...)}` in
// record-read.runner.ts for the correct pattern.
//
// Only collapse the trailing repeat index (`metric:150`, `sample-03`, `-32`).
// `:\d+` is anchored to the end on purpose: a mid-string numeric segment such as
// the keyword in `host:2024:sample-05` identifies a distinct operation and must
// not be merged with `host:2025:sample-05`.
export const normalizeTraceStepShape = (stepId: string) =>
  stepId
    .replace(/\bsample-\d+\b/g, "sample-#")
    .replace(/:\d+$/g, ":#")
    .replace(/-\d+$/g, "-#");

export const getSavedTraceStepShapes = (
  refs: TraceShapeRef[],
  savedTraceIds: ReadonlySet<string>,
) =>
  new Set(
    refs
      .filter((ref) => savedTraceIds.has(ref.traceId))
      .map((ref) => normalizeTraceStepShape(ref.stepId)),
  );

export const hasSavedTraceStepShape = (
  ref: TraceShapeRef,
  refs: TraceShapeRef[],
  savedTraceIds: ReadonlySet<string>,
) =>
  getSavedTraceStepShapes(refs, savedTraceIds).has(
    normalizeTraceStepShape(ref.stepId),
  );
