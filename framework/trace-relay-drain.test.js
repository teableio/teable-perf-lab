import assert from "node:assert/strict";
import test from "node:test";
import {
  parseTraceRelayMetrics,
  waitForTraceRelayDrain,
} from "./trace-relay-drain.ts";

const metrics = ({
  queueSize,
  inFlightRequests,
  acceptedSpans = 10,
  sentSpans = 10,
  enqueueFailedSpans = 0,
  sendFailedSpans = 0,
}) => `
otelcol_exporter_queue_size{exporter="otlp_http/jaeger",service_instance_id="test"} ${queueSize}
otelcol_exporter_in_flight_requests{exporter="otlp_http/jaeger",service_instance_id="test"} ${inFlightRequests}
otelcol_receiver_accepted_spans{receiver="otlp",service_instance_id="test"} ${acceptedSpans}
otelcol_exporter_sent_spans{exporter="otlp_http/jaeger",service_instance_id="test"} ${sentSpans}
otelcol_exporter_enqueue_failed_spans{exporter="otlp_http/jaeger",service_instance_id="test"} ${enqueueFailedSpans}
otelcol_exporter_send_failed_spans{exporter="otlp_http/jaeger",service_instance_id="test"} ${sendFailedSpans}
`;

test("parses relay queue and failure counters", () => {
  assert.deepEqual(
    parseTraceRelayMetrics(
      metrics({
        queueSize: 12,
        inFlightRequests: 1,
        enqueueFailedSpans: 2,
        sendFailedSpans: 3,
      }),
    ),
    {
      queueSize: 12,
      inFlightRequests: 1,
      acceptedSpans: 10,
      sentSpans: 10,
      enqueueFailedSpans: 2,
      sendFailedSpans: 3,
    },
  );
});

test("requires two stable empty samples before declaring the relay drained", async () => {
  const samples = [
    metrics({ queueSize: 8, inFlightRequests: 1 }),
    metrics({
      queueSize: 0,
      inFlightRequests: 0,
      acceptedSpans: 10,
      sentSpans: 9,
    }),
    metrics({ queueSize: 0, inFlightRequests: 0 }),
    metrics({ queueSize: 0, inFlightRequests: 0 }),
  ];
  let clock = 0;
  const result = await waitForTraceRelayDrain({
    metricsUrl: "http://relay/metrics",
    timeoutMs: 1_000,
    fetchMetrics: async () => samples.shift(),
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  });

  assert.equal(result.pollCount, 4);
  assert.equal(result.queueSize, 0);
  assert.equal(result.inFlightRequests, 0);
  assert.equal(result.acceptedSpans, 10);
  assert.equal(result.sentSpans, 10);
  assert.equal(result.durationMs, 750);
});

test("treats an omitted zero in-flight metric as idle", () => {
  const parsed = parseTraceRelayMetrics(
    metrics({ queueSize: 0, inFlightRequests: 0 }).replace(
      /^otelcol_exporter_in_flight_requests.*\n/m,
      "",
    ),
  );
  assert.equal(parsed.inFlightRequests, 0);
});

test("fails with the final queue state when the relay cannot drain", async () => {
  let clock = 0;
  await assert.rejects(
    waitForTraceRelayDrain({
      metricsUrl: "http://relay/metrics",
      timeoutMs: 500,
      fetchMetrics: async () =>
        metrics({
          queueSize: 4,
          inFlightRequests: 1,
          sendFailedSpans: 9,
        }),
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    }),
    /queue=4, inFlight=1, acceptedSpans=10, sentSpans=10, enqueueFailedSpans=0, sendFailedSpans=9/,
  );
});
