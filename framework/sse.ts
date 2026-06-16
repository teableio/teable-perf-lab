import { axios } from "@teable/openapi";
import type { PerfCase, PerfRunContext } from "./types";
import {
  buildPerfTraceHeaders,
  recordPerfTraceRefFromHeaders,
} from "./trace-collector";

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

const parseSseLine = <T extends PerfSseEvent>(line: string): T | undefined => {
  if (!line.startsWith("data:")) {
    return undefined;
  }

  const jsonStr = line.slice(5).trim();
  if (!jsonStr || jsonStr === "[DONE]") {
    return undefined;
  }

  return JSON.parse(jsonStr) as T;
};

const readSseEvents = async <T extends PerfSseEvent>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<T[]> => {
  const decoder = new TextDecoder();
  const events: T[] = [];
  let buffer = "";

  const processLine = (line: string) => {
    const event = parseSseLine<T>(line);
    if (event) {
      events.push(event);
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    lines.forEach(processLine);
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    processLine(buffer);
  }

  return events;
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
}): Promise<PerfSseResult<T>> => {
  const response = await fetch(url, {
    method,
    credentials: "include",
    signal,
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
    events: await readSseEvents<T>(reader),
    headers: responseHeaders,
    status: response.status,
    trace: {
      traceparent: responseHeaders.traceparent,
      traceLink: parseTraceLink(responseHeaders.link),
    },
  };
};
