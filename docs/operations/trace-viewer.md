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

Sizes, measured end to end on full run `30708195561`: it selected 1,012 traces
out of ~12 million spans, published all of them into the report-local Jaeger,
and stored **663 MB** of Jaeger-format snapshots in the artifact. The site
publishes only the trace each result row links to — 533 of them, averaging
**232 KB** once tag values are bounded — so a published full run costs
**~124 MB**.

The site therefore keeps roughly **six full runs** inside its 800 MB budget, and
single-case runs cost almost nothing (~6 KB each). Artifacts expire on an
investigation window rather than a storage limit, because Actions storage is
free on a public repository.

An earlier estimate of 84 MB came from extrapolating one shard's _median_ trace
size. The distribution is right-skewed — the largest published trace in that run
is 594 KB against a 152 KB median — so the median understated the total by
nearly half. Re-measure from a full run, not a shard, if the case catalog grows.

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

## When Jaeger does not answer

It fails the run, and that is the intended behaviour: the report job starts the
container and waits for `GET /api/services` before publishing, so a Jaeger that
does not answer afterwards is a fault in this workflow rather than someone
else's outage.

That was not always true. While the shared service was down, the publish path
grew a preflight probe and a degradation branch that skipped publication and
reconciled every manifest to `hard-outage`, because an external host being gone
should not redden a run whose measurements were fine — it had kept the suite red
for ~30 hours across 11 runs. Owning the container removed the condition that
logic existed for, so it was deleted rather than left to rot: a report job that
cannot reach its own Jaeger should say so loudly.

What survived is the diagnosis it came with. `fetch` reports every connection
failure as a bare "fetch failed" and hides the errno on `error.cause`, which is
why those 11 red runs recorded nothing usable; the publish path still unwraps it.

## History

Runs used to export to a shared Jaeger on the GCP `observability-stack` VM in
`teable-666` (`us-central1-a`). When that host went away, every full run failed
in the report job even though execute jobs had already captured and stored their
traces locally: the publish step could not reach it, and full-run acceptance
gated on that step. Nothing points at it any more.
