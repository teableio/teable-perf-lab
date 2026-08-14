export type NormalizedPerfError = {
  name?: string;
  message: string;
  stack?: string;
  /** HTTP status, when the failure came back from the server. */
  status?: number;
  /** The server's own error body, truncated. See `MAX_RESPONSE_CHARS`. */
  response?: string;
};

// How much of the server's error body to keep.
//
// Enough for a Nest error envelope with a stack, and bounded because this is
// written into every artifact and into the Performance Track row. The point is
// to name the exception, not to carry the whole response.
export const MAX_RESPONSE_CHARS = 2000;

const asText = (data: unknown): string | undefined => {
  if (data == null || data === "") {
    return undefined;
  }
  if (typeof data === "string") {
    return data;
  }
  try {
    return JSON.stringify(data);
  } catch {
    // Circular, or something that will not serialize. Its shape is still worth
    // recording; its contents are not recoverable here.
    return String(data);
  }
};

/**
 * What the server said, when the failure is an HTTP response.
 *
 * Only `response.status` and `response.data` are read. `config` and `request`
 * are deliberately left alone: they carry the whole request body, which on a
 * 1,000-record update is the payload this harness exists to send.
 */
const serverDetail = (
  error: unknown,
): Pick<NormalizedPerfError, "status" | "response"> => {
  const response = (
    error as { response?: { status?: unknown; data?: unknown } }
  )?.response;
  if (!response || typeof response !== "object") {
    return {};
  }
  const status =
    typeof response.status === "number" ? response.status : undefined;
  const body = asText(response.data);
  return {
    status,
    response:
      body === undefined
        ? undefined
        : body.length > MAX_RESPONSE_CHARS
          ? `${body.slice(0, MAX_RESPONSE_CHARS)}… (${body.length} chars)`
          : body,
  };
};

export const normalizePerfError = (error: unknown): NormalizedPerfError => {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...serverDetail(error),
    };
  }

  return { message: String(error), ...serverDetail(error) };
};

/**
 * The server's message, folded into the client's, for the CI log.
 *
 * Axios reports every server failure as `Request failed with status code 500`,
 * which is the same sentence whatever went wrong. That sentence is what CI
 * printed for eleven consecutive failures of five cases over two days, and it
 * is why the commit that broke them could be identified while the exception
 * could not.
 */
export const describePerfError = (normalized: NormalizedPerfError): string =>
  normalized.response === undefined
    ? normalized.message
    : `${normalized.message} — server said: ${normalized.response}`;

// Axios errors retain request/response/config objects. Re-throwing one through
// Vitest can serialize the entire request body even though the artifact only
// needs its name, message, stack, and what the server answered. Return a plain
// Error after artifacts have been written so large fixture payloads do not
// flood local or CI logs.
export const toPerfTestFailure = (error: unknown): Error => {
  const normalized = normalizePerfError(error);
  const failure = new Error(describePerfError(normalized));
  failure.name = normalized.name ?? "Error";
  if (normalized.stack) failure.stack = normalized.stack;
  return failure;
};
