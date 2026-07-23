const TRACE_ID_HEX_LENGTH = 32;
const TRACE_ID_PREFIX_HEX_LENGTH = 28;
const TRACE_ID_SUFFIX_SPACE = 0x10000;

export const DEFAULT_PERF_TRACE_EXPORT_RATIO = 0.001;

export const hashTraceId = (traceId: string) => {
  let hash = 2166136261;
  for (let index = 0; index < traceId.length; index += 1) {
    hash ^= traceId.charCodeAt(index);
    hash = (hash * 16777619) >>> 0;
  }
  return hash % 10000;
};

const assertExportRatio = (exportRatio: number) => {
  if (!Number.isFinite(exportRatio) || exportRatio <= 0 || exportRatio > 1) {
    throw new Error("Trace export ratio must be greater than 0 and at most 1");
  }
};

export const isTraceIdExportable = (traceId: string, exportRatio: number) => {
  if (
    !/^[0-9a-f]{32}$/.test(traceId) ||
    !Number.isFinite(exportRatio) ||
    exportRatio <= 0
  ) {
    return false;
  }
  return hashTraceId(traceId) < Math.min(exportRatio, 1) * 10000;
};

const buildTraceIdForDecision = (
  prefix: string,
  exportRatio: number,
  exportable: boolean,
) => {
  if (!/^[0-9a-f]{28}$/.test(prefix)) {
    throw new Error("Trace ID prefix must be 28 lowercase hexadecimal digits");
  }
  assertExportRatio(exportRatio);

  for (let suffix = 0; suffix < TRACE_ID_SUFFIX_SPACE; suffix += 1) {
    const traceId = `${prefix}${suffix.toString(16).padStart(4, "0")}`;
    if (traceId.length !== TRACE_ID_HEX_LENGTH) {
      continue;
    }
    if (isTraceIdExportable(traceId, exportRatio) === exportable) {
      return traceId;
    }
  }

  throw new Error(
    `Unable to build a ${
      exportable ? "" : "non-"
    }exportable trace ID for ratio ${exportRatio}`,
  );
};

export const buildExportableTraceId = (prefix: string, exportRatio: number) =>
  buildTraceIdForDecision(prefix, exportRatio, true);

export const buildNonExportableTraceId = (
  prefix: string,
  exportRatio: number,
) => buildTraceIdForDecision(prefix, exportRatio, false);

export const getTraceCheckpointIndexes = (total: number) => {
  if (!Number.isInteger(total) || total <= 0) {
    throw new Error("Trace checkpoint total must be a positive integer");
  }

  return [...new Set([0, Math.floor((total - 1) / 2), total - 1])];
};

export const isTraceCheckpoint = (index: number, total: number) => {
  if (!Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error("Trace checkpoint index must be a valid zero-based index");
  }
  return getTraceCheckpointIndexes(total).includes(index);
};

export interface TraceStepCheckpoint {
  index: number;
  total: number;
}

export const shouldExportTraceStepRequest = ({
  requestIndex,
  requestCount,
  checkpoint,
}: {
  requestIndex: number;
  requestCount?: number;
  checkpoint?: TraceStepCheckpoint;
}) => {
  if (!Number.isInteger(requestIndex) || requestIndex < 0) {
    throw new Error("Trace step request index must be a zero-based integer");
  }

  if (requestCount != null) {
    if (requestIndex >= requestCount) {
      throw new Error(
        `Trace step request index ${requestIndex} exceeded its declared request count ${requestCount}`,
      );
    }
    return isTraceCheckpoint(requestIndex, requestCount);
  }

  if (checkpoint) {
    return (
      requestIndex === 0 &&
      isTraceCheckpoint(checkpoint.index, checkpoint.total)
    );
  }

  return requestIndex === 0;
};

export const parsePerfTraceExportRatio = (value: unknown) => {
  const parsed =
    typeof value === "string" && value.trim() !== ""
      ? Number(value)
      : DEFAULT_PERF_TRACE_EXPORT_RATIO;
  assertExportRatio(parsed);
  return parsed;
};
