export interface TraceRelayMetrics {
  queueSize: number;
  inFlightRequests: number;
  acceptedSpans: number;
  sentSpans: number;
  enqueueFailedSpans: number;
  sendFailedSpans: number;
}

export interface TraceRelayDrainResult extends TraceRelayMetrics {
  durationMs: number;
  pollCount: number;
}

const metricValue = (
  metrics: string,
  metricName: string,
  requiredLabel?: string,
) => {
  const values = metrics
    .split(/\r?\n/)
    .filter(
      (line) =>
        (line.startsWith(`${metricName}{`) ||
          line.startsWith(`${metricName} `)) &&
        (!requiredLabel || line.includes(requiredLabel)),
    )
    .map((line) => Number(line.trim().split(/\s+/).at(-1)))
    .filter(Number.isFinite);

  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((sum, value) => sum + value, 0);
};

export const parseTraceRelayMetrics = (
  metrics: string,
  exporterId = "otlp_http/jaeger",
): TraceRelayMetrics => {
  const queueSize = metricValue(
    metrics,
    "otelcol_exporter_queue_size",
    `exporter="${exporterId}"`,
  );

  if (queueSize == null) {
    throw new Error(
      `Trace relay metrics are missing queue state for exporter ${exporterId}`,
    );
  }

  return {
    queueSize,
    inFlightRequests:
      metricValue(
        metrics,
        "otelcol_exporter_in_flight_requests",
        `exporter="${exporterId}"`,
      ) ?? 0,
    acceptedSpans: metricValue(metrics, "otelcol_receiver_accepted_spans") ?? 0,
    sentSpans:
      metricValue(
        metrics,
        "otelcol_exporter_sent_spans",
        `exporter="${exporterId}"`,
      ) ?? 0,
    enqueueFailedSpans:
      metricValue(
        metrics,
        "otelcol_exporter_enqueue_failed_spans",
        `exporter="${exporterId}"`,
      ) ?? 0,
    sendFailedSpans:
      metricValue(
        metrics,
        "otelcol_exporter_send_failed_spans",
        `exporter="${exporterId}"`,
      ) ?? 0,
  };
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export const waitForTraceRelayDrain = async ({
  metricsUrl,
  exporterId = "otlp_http/jaeger",
  timeoutMs,
  pollIntervalMs = 250,
  stablePolls = 2,
  fetchMetrics = async (url: string, requestTimeoutMs: number) => {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) {
      throw new Error(
        `Trace relay metrics returned ${response.status} ${response.statusText}`,
      );
    }
    return response.text();
  },
  now = Date.now,
  sleep = defaultSleep,
}: {
  metricsUrl: string;
  exporterId?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
  stablePolls?: number;
  fetchMetrics?: (url: string, requestTimeoutMs: number) => Promise<string>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<TraceRelayDrainResult> => {
  const startedAt = now();
  const deadlineAt = startedAt + timeoutMs;
  let pollCount = 0;
  let consecutiveEmptyPolls = 0;
  let lastMetrics: TraceRelayMetrics | undefined;

  while (now() < deadlineAt) {
    const remainingMs = Math.max(1, deadlineAt - now());
    const body = await fetchMetrics(metricsUrl, Math.min(3_000, remainingMs));
    pollCount += 1;
    lastMetrics = parseTraceRelayMetrics(body, exporterId);

    if (
      lastMetrics.queueSize === 0 &&
      lastMetrics.inFlightRequests === 0 &&
      lastMetrics.acceptedSpans === lastMetrics.sentSpans &&
      lastMetrics.enqueueFailedSpans === 0 &&
      lastMetrics.sendFailedSpans === 0
    ) {
      consecutiveEmptyPolls += 1;
      if (consecutiveEmptyPolls >= stablePolls) {
        return {
          ...lastMetrics,
          durationMs: now() - startedAt,
          pollCount,
        };
      }
    } else {
      consecutiveEmptyPolls = 0;
    }

    await sleep(Math.min(pollIntervalMs, Math.max(1, deadlineAt - now())));
  }

  throw new Error(
    `Trace relay did not drain within ${timeoutMs}ms` +
      (lastMetrics
        ? ` (queue=${lastMetrics.queueSize}, inFlight=${lastMetrics.inFlightRequests}, acceptedSpans=${lastMetrics.acceptedSpans}, sentSpans=${lastMetrics.sentSpans}, enqueueFailedSpans=${lastMetrics.enqueueFailedSpans}, sendFailedSpans=${lastMetrics.sendFailedSpans})`
        : ""),
  );
};
