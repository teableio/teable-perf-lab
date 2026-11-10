import { axios } from "@teable/openapi";
import type { PerfCase, PerfRunContext } from "./types";
import {
  buildPerfTraceHeaders,
  recordPerfTraceRefFromHeaders,
} from "./trace-collector";
import { pokeWatchdogActivity } from "./watchdog";
import { readSseEvents } from "./sse-reader";

// Merge the per-case watchdog signal (context.signal) with any caller-supplied
// signal so a watchdog trip aborts the stream. Returns undefined when neither is
// present.
const combineSignals = (
  ...signals: Array<AbortSignal | undefined>
): AbortSignal | undefined => {
  const present = signals.filter((s): s is AbortSignal => Boolean(s));
  if (present.length <= 1) {
    return present[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(present);
  }
  const controller = new AbortController();
  for (const s of present) {
    if (s.aborted) {
      controller.abort(s.reason);
      break;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), {
      once: true,
    });
  }
  return controller.signal;
};

type HeaderInput = HeadersInit | Record<string, unknown> | undefined;

export type PerfSseEvent = { id: string } | { type: string };

export type PerfSseResult<T extends PerfSseEvent> = {
  events: T[];
  headers: Record<string, string>;
  status: number;
  trace: {
    traceparent?: string;
    traceLink?: string;
  };
};

const hasToJson = (headers: unknown): headers is { toJSON: () => unknown } =>
  typeof headers === "object" &&
  headers != null &&
  "toJSON" in headers &&
  typeof (headers as { toJSON?: unknown }).toJSON === "function";

const toHeaderRecord = (headers?: HeaderInput): Record<string, string> => {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  if (hasToJson(headers)) {
    return toHeaderRecord(headers.toJSON() as HeaderInput);
  }

  return Object.fromEntries(
    Object.entries(headers).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
};

const buildSseRequestHeaders = (
  method: string,
  headers?: HeaderInput,
): Record<string, string> => {
  const resolvedMethod = method.toLowerCase();
  const methodHeaders =
    resolvedMethod in axios.defaults.headers
      ? toHeaderRecord(
          (axios.defaults.headers as Record<string, unknown>)[
            resolvedMethod
          ] as HeaderInput,
        )
      : {};

  return {
    ...toHeaderRecord(axios.defaults.headers.common as HeaderInput),
    ...methodHeaders,
    Accept: "text/event-stream",
    ...toHeaderRecord(headers),
  };
};

const parseTraceLink = (linkHeader?: string) =>
  linkHeader
    ?.split(",")
    .map((part) => part.trim())
    .find((part) => /;\s*rel="?trace"?/i.test(part))
    ?.match(/^<([^>]+)>/)?.[1];

export const perfStreamSse = async <T extends PerfSseEvent>({
  context,
  perfCase,
  stepId,
  url,
  method,
  headers,
  body,
  signal,
  errorPrefix = "SSE stream failed",
  onEvent,
  collectEvents,
  isTerminal,
}: {
  context: PerfRunContext;
  perfCase: PerfCase;
  stepId: string;
  url: string;
  method: string;
  headers?: HeaderInput;
  body?: BodyInit;
  signal?: AbortSignal;
  errorPrefix?: string;
  onEvent?: (event: T) => void | Promise<void>;
  collectEvents?: boolean;
  isTerminal?: (event: T) => boolean;
}): Promise<PerfSseResult<T>> => {
  const response = await fetch(url, {
    method,
    credentials: "include",
    signal: combineSignals(context.signal, signal),
    headers: buildSseRequestHeaders(method, {
      ...buildPerfTraceHeaders(context, perfCase, stepId),
      ...toHeaderRecord(headers),
    }),
    body,
  });
  const responseHeaders = Object.fromEntries(response.headers.entries());

  recordPerfTraceRefFromHeaders({
    context,
    perfCase,
    stepId,
    headers: responseHeaders,
    method,
    url,
    requestBody: body,
    status: response.status,
  });

  if (!response.ok) {
    throw new Error(
      `${errorPrefix}: ${response.status} ${await response.text()}`,
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body for SSE stream");
  }

  return {
    events: await readSseEvents<T>(reader, {
      onEvent,
      collectEvents,
      isTerminal,
      onActivity: pokeWatchdogActivity,
    }),
    headers: responseHeaders,
    status: response.status,
    trace: {
      traceparent: responseHeaders.traceparent,
      traceLink: parseTraceLink(responseHeaders.link),
    },
  };
};
