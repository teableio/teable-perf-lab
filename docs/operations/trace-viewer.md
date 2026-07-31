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

| Copy                     | Location                                                              | Retention               |
| ------------------------ | --------------------------------------------------------------------- | ----------------------- |
| Every span               | `trace-spool.jsonl` in the execute job's runner temp                  | Dies with the job       |
| Selected traces (OTLP)   | `selected-traces.otlp.jsonl` in the execute artifact                  | 1 day                   |
| Selected traces (Jaeger) | `traces/<case>-<engine>/<step>-<traceId>.json` in the run's artifacts | 1 day                   |
| One trace per result row | `r/<runId>/<traceId>.json` on the `trace-pages` branch                | 1 day after publication |
| Pinned traces            | `pinned/<traceId>.json` on the `trace-pages` branch                   | Until unpinned          |

A full run selects about 1,000 traces out of ~12 million spans, which is ~414 MB
of JSON. That is why everything except a pinned trace expires after a day.

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

Published traces are pruned 24 hours after their run. To keep one — for an
issue, a regression writeup, anything that outlives the run — run the **Pin perf
trace** workflow with the run id and trace id. It copies the trace into
`pinned/`, which the prune never touches, and it is reachable at
`trace.html?pinned=<traceId>`. The same workflow unpins.

Locally:

```bash
node scripts/pin-perf-trace.mjs --site <checkout> --run-id <runId> --trace-id <traceId>
node scripts/pin-perf-trace.mjs --site <checkout> --trace-id <traceId> --unpin
```

## Publishing

`scripts/publish-trace-pages.mjs` builds the site from the run's own artifacts:
it takes the trace each result row links to, bounds every tag value to 2 KB and
every trace to 3,000 spans, writes `r/<runId>/`, prunes runs older than 24 hours,
and rebuilds `runs.json`. `.github/actions/trace-site` owns the git side and
pushes one root commit per publish, so the branch never accumulates superseded
trace JSON.

The site is public, like the repository. `db.postgresql.values` is redacted
before a trace ever leaves the execute job, and SQL text is bounded, but the
statements, request paths, and table and field ids are visible to anyone with
the link.

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
