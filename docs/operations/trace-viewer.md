# Trace Viewer

Perf runs carry their own trace pipeline. Nothing outside a run has to stay up
for traces to be captured, stored, or shared.

```
teable-ee ──OTLP──▶ job-local otel relay ──▶ trace-spool.jsonl (execute job)
                                              │ selected traces only
                                              ▼
                                     selected-traces.otlp.jsonl (artifact)
                                              │ report job
                                              ▼
                          report-local Jaeger container ──▶ Jaeger JSON snapshots
                                              │                    (artifact, 1 day)
                                              ▼
                              trace-pages branch ──▶ GitHub Pages viewer
```

## Where a trace lives

| Copy                     | Location                                                              | Retention                     |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------- |
| Every span               | `trace-spool.jsonl` in the execute job's runner temp                  | Dies with the job             |
| Selected traces (OTLP)   | `selected-traces.otlp.jsonl` in the execute artifact                  | 14 days                       |
| Selected traces (Jaeger) | `traces/<case>-<engine>/<step>-<traceId>.json` in the run's artifacts | 14 days                       |
| One trace per result row | `r/<runId>/<traceId>.json` on the `trace-pages` branch                | While it fits the 800 MB site |
| Pinned traces            | `pinned/<traceId>.json` on the `trace-pages` branch                   | Until unpinned                |

Sizes, measured on run `30600597922`: a full run selects ~1,000 traces out of
~12 million spans, or ~414 MB of OTLP JSON. The site publishes only the trace
each result row links to — 540 of them, at a ~156 KB median once tag values are
bounded — so a published full run costs about **84 MB**.

The site therefore keeps roughly **nine full runs** inside its 800 MB budget,
and single-case runs cost almost nothing. Artifacts expire on an investigation
window rather than a storage limit, because Actions storage is free on a public
repository.

## Reading a trace

- **From a result row** — the `Trace URL` field in the Teable `Performance
Track` table, and the `primary trace` row in each case's summary markdown,
  link to <https://teableio.github.io/teable-perf-lab/>. The viewer renders the
  span waterfall, supports filtering by name/service/tag, highlights the ten
  slowest spans, and expands a span's tags on click.
- **Everything a run captured** — download the run's
  `teable-ee-e2e-perf-reconciled-results-<runId>` artifact, start any Jaeger,
  and upload a snapshot JSON through the Jaeger UI's _JSON File_ tab:

  ```bash
  docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:1.76.0
  ```

  The snapshots are verbatim `/api/traces/<traceId>` responses, so they load
  without conversion.

## Pinning a trace

A run is evicted once the site needs its bytes for newer runs. To keep one
trace — for an issue, a regression writeup, anything that outlives the run — run
the **Pin perf trace** workflow with the run id and trace id. It copies the
trace into `pinned/`, which eviction never touches, and it is reachable at
`trace.html?pinned=<traceId>`. The same workflow unpins.

Pinned bytes count against the budget, so pinning trades site capacity for
permanence. If pinned traces plus the run being published no longer fit, the
publish step keeps the run anyway, goes over budget, and emits a warning — that
is the signal to unpin something before the site reaches the 1 GB Pages ceiling.

Locally:

```bash
node scripts/pin-perf-trace.mjs --site <checkout> --run-id <runId> --trace-id <traceId>
node scripts/pin-perf-trace.mjs --site <checkout> --trace-id <traceId> --unpin
```

## Publishing

`scripts/publish-trace-pages.mjs` builds the site from the run's own artifacts:
it takes the trace each result row links to, bounds every tag value to 2 KB and
every trace to 3,000 spans, writes `r/<runId>/`, evicts whole runs oldest-first
until the site fits its byte budget, and rebuilds `runs.json`. Pass
`--budget-bytes` to change the cap. `.github/actions/trace-site` owns the git
side and pushes one root commit per publish, so the branch never accumulates
superseded trace JSON.

The site is public, like the repository. `db.postgresql.values` is redacted
before a trace ever leaves the execute job, and SQL text is bounded, but the
statements, request paths, and table and field ids are visible to anyone with
the link.

Pages rebuilds are rate-limited to ten an hour. A burst of single-case runs can
push more often than that; the push still succeeds and the branch is correct,
but the served site can lag by a few minutes. Read the branch directly if a
link has not caught up yet.

## Local runs

Point a local run at your own Jaeger and everything works the same way:

```bash
docker run --rm -p 16686:16686 -p 4318:4318 jaegertracing/all-in-one:1.76.0
export PERF_LAB_JAEGER_API_BASE_URL=http://127.0.0.1:16686
export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318/v1/traces
```

## History

Runs used to export to a shared Jaeger on the GCP `observability-stack` VM in
`teable-666` (`us-central1-a`). When that host went away, every full run failed
in the report job even though execute jobs had already captured and stored their
traces locally: the publish step could not reach it, and full-run acceptance
gated on that step. Nothing points at it any more.
