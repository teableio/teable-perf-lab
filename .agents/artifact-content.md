# Perf artifact content reference

Read this before downloading a run's artifacts. It documents the exact files and
JSON shapes the execute jobs produce, so you can go straight to the field you
need instead of unpacking an artifact to learn its structure.

The shapes are authoritative as of the framework source:

- payload: `PerfArtifactPayload` in [../framework/artifacts.ts](../framework/artifacts.ts)
- trace manifest: `PerfTraceArtifactSummary` in [../framework/trace-collector.ts](../framework/trace-collector.ts)
- routing block: `EngineRouting` in [../framework/routing.ts](../framework/routing.ts)

## Which artifact to download

Each execute job uploads full and lightweight pre-publication artifacts. The
report job uploads one reconciled artifact after shared-Jaeger verification.
See the artifact name list in
[../docs/operations/teable-ee-e2e.md](../docs/operations/teable-ee-e2e.md).

- `teable-ee-e2e-perf-results-v*-<run>-<attempt>` — lightweight, the default the
  report job resolves. It includes the filtered OTLP payload and
  `pending-shared-publish` manifests.
- `teable-ee-e2e-perf-v*-<run>-<attempt>` — full execute diagnostics, including
  spool summary, Collector logs, metrics, and state.
- `teable-ee-e2e-perf-reconciled-results-<run>-<attempt>` — final payloads,
  summaries, and manifests after serialized publication. Use this for accepted
  trace counts and links.

## Layout

```text
<artifact-root>/
  <case-id>-<engine>.json                 # payload (results + full artifact)
  summary-<case-id>-<engine>.md           # GitHub summary (results + full)
  selected-traces-summary.json            # local spool reduction metrics
  selected-traces.otlp.jsonl              # selected OTLP (execute artifacts only)
  traces/
    <case-id>-<engine>/
      manifest.json                       # trace summary (results + full)
```

`<case-id>` and `<engine>` are sanitized: non `[A-Za-z0-9_.-]` runs become `-`,
so `formula/10k-calc` + `v2` → `formula-10k-calc-v2`.

## `<case-id>-<engine>.json` — payload

The primary file. One per case+engine. Trace counts are duplicated inline here
(see `details.observability.traces`), so most checks never need `manifest.json`.
The case first writes a `pending-job-tail` trace block; the engine job tail
records `pending-shared-publish` after selecting evidence, and the report job
rewrites only that block after serialized shared-Jaeger publication. Metrics,
business details, routing evidence, result, and measured duration stay
unchanged.

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

Identical to `details.observability.traces` in the payload after normal job-tail
finalization. Read it standalone only if you are not already holding the
payload. An interrupted run can leave both at `pending-job-tail`; a tail failure
uses `tail-error` wherever the artifact directory remains writable.

```json
{
  "enabled": true,
  "traceRefCount": 37,
  "uniqueTraceCount": 21,
  "selectedTraceCount": 21,
  "selectedTraceIds": ["0af7651916cd43dd8448eb211c80319c"],
  "savedTraceCount": 20,
  "failedTraceCount": 1,
  "skippedTraceCount": 16,
  "missingFetchCount": 1,
  "wastedFetchMs": 3000,
  "traceFetchCaseBudgetMs": 15000,
  "traceFetchJobBudgetMs": 120000,
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
  "sharedPublishTraceCount": 21,
  "sharedPublishSpanCount": 8421,
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
accounts for every captured ref in `refs[]` and therefore equals
`traceRefCount`. `uniqueTraceCount` reports distinct trace IDs; duplicate refs
receive explicit skipped outcomes because the first ref owns the shared fetch
result. `skipped` also covers
unsampled refs, sampled refs above `maxSnapshotCount`, sampled refs outside a
case include pattern, repeated sampled GET or POST refs covered by a saved
representative for the same semantic request shape (normalized step + method +
URL path/query-key shape + request-body structure), and whole-case fetch skips
when the Trace service was unavailable or a trace budget/breaker opened. Each
skipped entry carries an `error` string explaining why it was not fetched.
`refs[]` lists every captured trace ref; `savedTraces[]` lists one outcome per
captured ref.
`traceFetchSkippedReason` is set only when the collector skipped Jaeger fetch for
the case, for example because the Trace service rejected the final OTEL flush.
This is not counted as trace polling waste.

`selectedTraceIds` is the exact publication allowlist generated in the execute
job. `sharedPublishTraceCount` and `sharedPublishSpanCount` record what the
single report job serialized into its own Jaeger container. The execute artifact
also carries
`selected-traces-summary.json` and `selected-traces.otlp.jsonl`; the latter is
excluded from the final reconciled artifact after publication.

`traceFetchWaitMs` is the case-attributed wait capped by
`traceFetchCaseBudgetMs`; `traceFetchJobWaitMs` is the actual cumulative elapsed
tail time observed when that manifest is finalized. It is compared with
`traceFetchJobBudgetMs` but deliberately not clamped, so post-deadline artifact
work cannot hide an SLO overrun. A non-`closed`
`traceFetchBreakerState` plus `traceFetchBreakerReason` preserves why retrieval
stopped. `partial-loss` can recover through a bounded probe;
`traceFetchRecoverySucceeded` records that transition. `pending-job-tail` means
the measured result exists but local trace selection did not complete;
`pending-shared-publish` means selection completed but the report job has not
published/reconciled it yet. `tail-error` means finalization or its artifact
rewrite failed without deleting that result. Artifact replacement uses
same-directory temporary files and atomic rename, so interruption keeps the
previous valid JSON instead of truncating it.

Execute artifacts carry no raw Jaeger snapshots; the report job writes them
after it publishes, at `savedTraces[].path` inside the reconciled artifact. Each
file is a verbatim `/api/traces/<traceId>` response, so it loads into any Jaeger
UI through the _JSON File_ tab. Both the artifact and the published viewer copy
expire after a day — see
[../docs/operations/trace-viewer.md](../docs/operations/trace-viewer.md) for
retention and for pinning a trace that has to outlive its run.

## What to read for a given question

| Question                        | Field                                                                                                     |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Did the case pass?              | `result`; per gate `thresholds[].passed`                                                                  |
| Primary metric value vs. budget | `thresholds[0].actual` vs `thresholds[0].max` (`thresholds[0].metric` names it)                           |
| All measured numbers            | `metrics`                                                                                                 |
| Phase breakdown                 | `phases[]`                                                                                                |
| V1/V2 routed correctly?         | `details.routing.routeMatched`, `.actualV2Header`, `.feature`                                             |
| Failure detail                  | `error.message`, `error.stack`                                                                            |
| Trace capture health            | `details.observability.traces.{traceRefCount,savedTraceCount,failedTraceCount,skippedTraceCount}`         |
| Why a trace was not saved       | `details.observability.traces.savedTraces[]` where `status` is `error`/`missing`/`skipped` (read `error`) |
| Open a trace in a browser       | The published viewer, linked from the summary's `primary trace` row and the Teable `Trace URL` field      |
| Span-level timings              | The published viewer, or the snapshot at `savedTraces[].path` loaded into a local Jaeger                  |
| Trace service unavailable       | `details.observability.traces.traceFetchSkippedReason`                                                    |

## jq quick paths

```bash
# pass/fail + primary metric for every case+engine in the results artifact
jq -r '[.caseId,.engine,.result,(.thresholds[0]|"\(.metric)=\(.actual)/\(.max)\(.unit) \(.passed)")] | @tsv' *-v*.json

# trace health straight from the payload (no need to open manifest.json)
jq '.details.observability.traces | {traceRefCount,savedTraceCount,failedTraceCount,skippedTraceCount}' *-v*.json

# every trace that was not saved, with the reason
jq -r '.details.observability.traces.savedTraces[] | select(.status!="saved" and .status!="skipped") | [.stepId,.status,.error] | @tsv' *-v*.json
```
