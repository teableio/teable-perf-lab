export type TraceShapeRef = {
  traceId: string;
  stepId: string;
};

export const normalizeTraceStepShape = (stepId: string) =>
  stepId
    .replace(/\bsample-\d+\b/g, "sample-#")
    .replace(/:\d+(?=$|\b)/g, ":#")
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
