# Perf artifact content reference

Read this before downloading a run's artifacts. It documents the exact files and
JSON shapes the execute jobs produce, so you can go straight to the field you
need instead of unpacking an artifact to learn its structure.

The shapes are authoritative as of the framework source:

- payload: `PerfArtifactPayload` in [../framework/artifacts.ts](../framework/artifacts.ts)
- trace manifest: `PerfTraceArtifactSummary` in [../framework/trace-collector.ts](../framework/trace-collector.ts)
- routing block: `EngineRouting` in [../framework/routing.ts](../framework/routing.ts)

## Which artifact to download

Each execute job (one per engine) uploads two artifacts. See the artifact name
list in [../docs/operations/teable-ee-e2e.md](../docs/operations/teable-ee-e2e.md).

- `teable-ee-e2e-perf-results-v*-<run>-<attempt>` — lightweight, the default the
  report job resolves. Contains everything except the raw Jaeger snapshots.
  Use this for metrics, thresholds, routing, summaries, and trace counts.
- `teable-ee-e2e-perf-v*-<run>-<attempt>` — full. Everything above **plus** the
  raw per-trace snapshot JSON. Only pull this when you must read span-level data.

## Layout

```text
<artifact-root>/
  <case-id>-<engine>.json                 # payload (results + full artifact)
  summary-<case-id>-<engine>.md           # GitHub summary (results + full)
  traces/
    <case-id>-<engine>/
      manifest.json                       # trace summary (results + full)
      <step-id>-<trace-id>.json           # raw Jaeger snapshot (FULL artifact only)
```

`<case-id>` and `<engine>` are sanitized: non `[A-Za-z0-9_.-]` runs become `-`,
so `formula/10k-calc` + `v2` → `formula-10k-calc-v2`.

## `<case-id>-<engine>.json` — payload

The primary file. One per case+engine. Trace counts are duplicated inline here
(see `details.observability.traces`), so most checks never need `manifest.json`.

```json
{
  "caseId": "formula/10k-calc",
  "title": "10k formula recompute",
  "runId": "1234567890-1-v2",
  "engine": "v2",
  "appUrl": "http://127.0.0.1:3000",
  "result": "pass",
  "startedAt": "2026-06-14T03:21:05.123Z",
  "finishedAt": "2026-06-14T03:21:48.456Z",
  "durationMs": 43333,
  "metrics": { "formulaReadyMs": 4120, "scannedRecords": 10000 },
  "thresholds": [
    {
      "metric": "formulaReadyMs",
      "max": 8000,
      "unit": "ms",
      "actual": 4120,
      "passed": true
    }
  ],
  "phases": [
    { "name": "createFormula", "durationMs": 180 },
    { "name": "formulaReady", "durationMs": 4120 }
  ],
  "details": {
    "routing": {
      "requestedEngine": "v2",
      "actualV2Header": "true",
      "routeMatched": true,
      "engineMatched": true,
      "featureMatched": true,
      "feature": "formula",
      "reason": ""
    },
    "observability": {
      "traces": "<identical object to traces/<case>-<engine>/manifest.json>"
    }
  },
  "error": null
}
```

Field notes:

- `result`: `"pass" | "fail" | "skipped"`. `skipped` is an intentional
  engine-capability gap, not a failure.
- `thresholds[0]` is the primary threshold. `actual` is `null` when the metric
  was never recorded; `passed` is `actual <= max`.
- `metrics` is the full number bag; `thresholds` only reflects the gated ones.
- `phases` is optional and runner-specific.
- `details` is runner-specific except for two stable keys:
  - `details.routing` (only for cases that assert V1/V2 routing) — full field
    set is `EngineRouting`; `routeMatched` is the headline.
  - `details.observability.traces` — the same object written to `manifest.json`.
- `error` is present only on failure: `{ name?, message, stack? }`.

## `traces/<case-id>-<engine>/manifest.json` — trace summary

Identical to `details.observability.traces` in the payload. Read it standalone
only if you are not already holding the payload.

```json
{
  "enabled": true,
  "traceRefCount": 37,
  "uniqueTraceCount": 21,
  "selectedTraceCount": 21,
  "savedTraceCount": 20,
  "failedTraceCount": 1,
  "skippedTraceCount": 16,
  "missingFetchCount": 1,
  "wastedFetchMs": 3000,
  "traceFetchCaseBudgetMs": 15000,
  "traceFetchJobBudgetMs": 60000,
  "traceFetchWaitMs": 8120,
  "traceFetchJobWaitMs": 42100,
  "traceFetchBreakerState": "partial-loss",
  "traceFetchBreakerReason": "Trace fetch breaker open: partial loss threshold 3 reached",
  "traceFetchRecoveryProbeCount": 1,
  "traceFetchRecoverySucceeded": false,
  "maxSnapshotCount": 100,
  "fetchConcurrency": 8,
  "backgroundFlushIntervalMs": 1000,
  "backgroundFlushCount": 12,
  "backgroundFlushErrorCount": 0,
  "flushDurationMs": 512,
  "traceFetchSkippedReason": null,
  "jaegerApiBaseUrl": "http://host:16686",
  "artifactDir": "traces/formula-10k-calc-v2",
  "manifestPath": "traces/formula-10k-calc-v2/manifest.json",
  "refs": [
    {
      "stepId": "create-formula-field",
      "traceId": "0af7651916cd43dd8448eb211c80319c",
      "sampled": true,
      "traceparent": "00-0af76519...-b7ad6b71...-01",
      "traceLink": "http://host:16686/trace/0af7651916cd43dd8448eb211c80319c?uiEmbed=v0",
      "method": "POST",
      "url": "http://127.0.0.1:3000/api/table/tblXXX/field",
      "requestBodyShape": "{\"name\":\"string\",\"type\":\"string\"}",
      "status": 201,
      "capturedAt": "2026-06-14T03:21:30.000Z"
    }
  ],
  "savedTraces": [
    {
      "traceId": "0af7651916cd43dd8448eb211c80319c",
      "stepId": "create-formula-field",
      "path": "traces/formula-10k-calc-v2/create-formula-field-0af7651916cd43dd8448eb211c80319c.json",
      "status": "saved",
      "attempts": 2,
      "durationMs": 1840,
      "sampled": true
    },
    {
      "traceId": "1b2c...",
      "stepId": "verify-scan",
      "path": "traces/formula-10k-calc-v2/verify-scan-1b2c....json",
      "status": "error",
      "error": "Jaeger API returned 404",
      "attempts": 120,
      "durationMs": 60000,
      "sampled": true
    }
  ]
}
```

Count relationships: `savedTraceCount + failedTraceCount + skippedTraceCount`
accounts for every unique ref in `refs[]` and therefore equals
`uniqueTraceCount`. `traceRefCount` is the raw captured count and can be higher
when duplicate trace IDs were observed. `skipped` covers
unsampled refs, sampled refs above `maxSnapshotCount`, sampled refs outside a
case include pattern, repeated sampled GET or POST refs covered by a saved
representative for the same semantic request shape (normalized step + method +
URL path/query-key shape + request-body structure), and whole-case fetch skips
when the Trace service was unavailable or a trace budget/breaker opened. Each
skipped entry carries an `error` string explaining why it was not fetched.
`refs[]` lists every unique captured trace; `savedTraces[]` lists one outcome per
unique ref.
`traceFetchSkippedReason` is set only when the collector skipped Jaeger fetch for
the case, for example because the Trace service rejected the final OTEL flush.
This is not counted as trace polling waste.

`traceFetchWaitMs` is the case-attributed wait capped by
`traceFetchCaseBudgetMs`; `traceFetchJobWaitMs` is cumulative for the execute job
and capped by `traceFetchJobBudgetMs`. A non-`closed`
`traceFetchBreakerState` plus `traceFetchBreakerReason` preserves why retrieval
stopped. `partial-loss` can recover through a bounded probe;
`traceFetchRecoverySucceeded` records that transition.

## `traces/<case-id>-<engine>/<step-id>-<trace-id>.json` — raw Jaeger snapshot

Full artifact only. This is the verbatim Jaeger `/api/traces/<id>` response and
is the heavy part of the artifact. Open it only for span-level debugging.

```json
{
  "data": [
    {
      "traceID": "0af7651916cd43dd8448eb211c80319c",
      "spans": [
        {
          "spanID": "b7ad6b7169203331",
          "operationName": "POST /api/table/:id/field",
          "duration": 1234,
          "tags": []
        }
      ],
      "processes": { "p1": { "serviceName": "teable-perf-v2" } }
    }
  ],
  "total": 0,
  "limit": 0,
  "offset": 0,
  "errors": null
}
```

## What to read for a given question

| Question                           | Field                                                                                                     |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Did the case pass?                 | `result`; per gate `thresholds[].passed`                                                                  |
| Primary metric value vs. budget    | `thresholds[0].actual` vs `thresholds[0].max` (`thresholds[0].metric` names it)                           |
| All measured numbers               | `metrics`                                                                                                 |
| Phase breakdown                    | `phases[]`                                                                                                |
| V1/V2 routed correctly?            | `details.routing.routeMatched`, `.actualV2Header`, `.feature`                                             |
| Failure detail                     | `error.message`, `error.stack`                                                                            |
| Trace capture health               | `details.observability.traces.{traceRefCount,savedTraceCount,failedTraceCount,skippedTraceCount}`         |
| Why a trace was not saved          | `details.observability.traces.savedTraces[]` where `status` is `error`/`missing`/`skipped` (read `error`) |
| Open a trace in the Jaeger UI      | any `refs[].traceLink`                                                                                    |
| Span-level timings (full artifact) | `traces/<case>-<engine>/<step>-<trace>.json` → `.data[0].spans`                                           |
| Trace service unavailable          | `details.observability.traces.traceFetchSkippedReason`                                                    |

## jq quick paths

```bash
# pass/fail + primary metric for every case+engine in the results artifact
jq -r '[.caseId,.engine,.result,(.thresholds[0]|"\(.metric)=\(.actual)/\(.max)\(.unit) \(.passed)")] | @tsv' *-v*.json

# trace health straight from the payload (no need to open manifest.json)
jq '.details.observability.traces | {traceRefCount,savedTraceCount,failedTraceCount,skippedTraceCount}' *-v*.json

# every trace that was not saved, with the reason
jq -r '.details.observability.traces.savedTraces[] | select(.status!="saved" and .status!="skipped") | [.stepId,.status,.error] | @tsv' *-v*.json
```
