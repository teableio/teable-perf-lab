import { normalizeTraceStepShape } from "./trace-classification";

export interface TraceEvidenceRef {
  traceId: string;
  stepId: string;
  sampled: boolean;
  method?: string;
  url?: string;
  requestBodyShape?: string;
}

const requestBodyShapeValue = (
  value: unknown,
  seen: WeakSet<object>,
  depth: number,
): unknown => {
  if (value == null) {
    return value === null ? "null" : "undefined";
  }
  if (depth >= 6) {
    return typeof value;
  }
  if (Array.isArray(value)) {
    return value.length > 0
      ? [requestBodyShapeValue(value[0], seen, depth + 1)]
      : [];
  }
  if (typeof value === "object") {
    if (seen.has(value)) {
      return "circular";
    }
    seen.add(value);
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [
        key,
        requestBodyShapeValue(child, seen, depth + 1),
      ]);
    return Object.fromEntries(entries);
  }
  return typeof value;
};

export const normalizeTraceRequestBodyShape = (body: unknown) => {
  if (body == null || body === "") {
    return "";
  }

  let value = body;
  if (typeof body === "string") {
    try {
      value = JSON.parse(body);
    } catch {
      return "string";
    }
  }

  return JSON.stringify(requestBodyShapeValue(value, new WeakSet(), 0));
};

const parseStepPatterns = (value: unknown) => {
  if (typeof value !== "string" || value.trim() === "") {
    return [];
  }

  return value
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern));
};

const matchesStepPattern = (patterns: RegExp[], ref: TraceEvidenceRef) =>
  patterns.length === 0 || patterns.some((pattern) => pattern.test(ref.stepId));

const getStepNumber = (stepId: string) => {
  const match = stepId.match(/^(.*):(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    prefix: match[1],
    number: Number(match[2]),
  };
};

const sortByDistanceFrom = <T extends TraceEvidenceRef>(
  failedRef: TraceEvidenceRef,
  refs: T[],
) => {
  const failedStepNumber = getStepNumber(failedRef.stepId);
  if (!failedStepNumber) {
    return refs;
  }

  return [...refs].sort((left, right) => {
    const leftStepNumber = getStepNumber(left.stepId);
    const rightStepNumber = getStepNumber(right.stepId);
    const leftDistance =
      leftStepNumber?.prefix === failedStepNumber.prefix
        ? Math.abs(leftStepNumber.number - failedStepNumber.number)
        : Number.POSITIVE_INFINITY;
    const rightDistance =
      rightStepNumber?.prefix === failedStepNumber.prefix
        ? Math.abs(rightStepNumber.number - failedStepNumber.number)
        : Number.POSITIVE_INFINITY;

    return leftDistance - rightDistance;
  });
};

const isPriorityRef = (ref: TraceEvidenceRef) =>
  /create.*field|formula|lookup/i.test(ref.stepId) ||
  /\/field\//i.test(ref.url ?? "");

const normalizePathSegment = (segment: string) => {
  if (
    /^(bse|tbl|rec|fld|viw|spc|usr|org|app)[a-zA-Z0-9_-]{6,}$/.test(segment)
  ) {
    return `:${segment.slice(0, 3)}`;
  }
  if (/^[a-zA-Z0-9_-]{16,}$/.test(segment) && /[A-Z_-]/.test(segment)) {
    return ":id";
  }
  return segment;
};

const normalizeUrlShape = (url?: string) => {
  if (!url) {
    return "";
  }

  try {
    const parsed = new URL(url);
    const path = parsed.pathname.split("/").map(normalizePathSegment).join("/");
    const queryKeys = Array.from(new Set(parsed.searchParams.keys())).sort();
    return queryKeys.length > 0 ? `${path}?${queryKeys.join("&")}` : path;
  } catch {
    return url;
  }
};

const requestShape = (ref: TraceEvidenceRef) =>
  [
    normalizeTraceStepShape(ref.stepId),
    ref.method?.toUpperCase() ?? "",
    normalizeUrlShape(ref.url),
    ref.requestBodyShape,
  ]
    .filter(Boolean)
    .join(" ");

export const createTraceEvidencePolicy = <T extends TraceEvidenceRef>({
  refs,
  includePattern,
  fallbackPattern,
  maxSnapshots,
}: {
  refs: T[];
  includePattern?: unknown;
  fallbackPattern?: unknown;
  maxSnapshots: number;
}) => {
  const includePatterns = parseStepPatterns(includePattern);
  const fallbackPatterns = parseStepPatterns(fallbackPattern);
  const candidates = refs.filter(
    (ref) => ref.sampled && matchesStepPattern(includePatterns, ref),
  );
  const selectedRefs: T[] = [];
  const selectedTraceIds = new Set<string>();
  const selectedFetchKeys = new Set<string>();

  const selectRef = (ref: T) => {
    if (
      selectedRefs.length >= maxSnapshots ||
      selectedTraceIds.has(ref.traceId)
    ) {
      return;
    }

    const fetchKey = requestShape(ref);
    if (selectedFetchKeys.has(fetchKey)) {
      return;
    }

    selectedRefs.push(ref);
    selectedTraceIds.add(ref.traceId);
    selectedFetchKeys.add(fetchKey);
  };

  for (const ref of candidates) {
    if (isPriorityRef(ref)) {
      selectRef(ref);
    }
  }
  for (const ref of candidates) {
    selectRef(ref);
  }

  const selectedRepresentativeByShape = new Map<string, T>();
  for (const ref of selectedRefs) {
    const shape = requestShape(ref);
    if (!selectedRepresentativeByShape.has(shape)) {
      selectedRepresentativeByShape.set(shape, ref);
    }
  }

  const fallbackRefs = refs.filter(
    (ref) =>
      ref.sampled &&
      !selectedTraceIds.has(ref.traceId) &&
      matchesStepPattern(fallbackPatterns, ref),
  );

  const savedRepresentative = (
    ref: TraceEvidenceRef,
    savedTraceIds: ReadonlySet<string>,
  ) => {
    const shape = requestShape(ref);
    return refs.find(
      (candidate) =>
        savedTraceIds.has(candidate.traceId) &&
        requestShape(candidate) === shape,
    );
  };

  return {
    selectedRefs,
    requestShape,
    hasSavedRepresentative(
      ref: TraceEvidenceRef,
      savedTraceIds: ReadonlySet<string>,
    ) {
      return savedRepresentative(ref, savedTraceIds) != null;
    },
    fallbackCandidates(failedRef: TraceEvidenceRef) {
      const failedShape = requestShape(failedRef);
      return sortByDistanceFrom(
        failedRef,
        fallbackRefs.filter((ref) => requestShape(ref) === failedShape),
      );
    },
    explainUnfetched(
      ref: TraceEvidenceRef,
      {
        savedTraceIds,
        error,
      }: {
        savedTraceIds: ReadonlySet<string>;
        error?: string;
      },
    ) {
      if (error) {
        return error;
      }
      if (!ref.sampled) {
        return "Traceparent is not sampled, so Jaeger is not expected to store it";
      }
      if (!matchesStepPattern(includePatterns, ref)) {
        return `Sampled trace was not fetched because stepId did not match PERF_LAB_TRACE_INCLUDE_STEP_PATTERN=${includePattern}`;
      }

      const savedRef = savedRepresentative(ref, savedTraceIds);
      const selectedRef = selectedRepresentativeByShape.get(requestShape(ref));
      const representative = savedRef ?? selectedRef;
      if (representative && representative.traceId !== ref.traceId) {
        return `Sampled trace was not fetched because ${representative.traceId} from ${representative.stepId} was ${
          savedRef ? "saved" : "selected"
        } as the representative for request shape ${requestShape(ref)}`;
      }

      return `Sampled trace was not fetched because PERF_LAB_TRACE_MAX_SNAPSHOTS=${maxSnapshots}`;
    },
  };
};
