# Trace Viewer

Perf runs export OpenTelemetry traces to the shared Jaeger service on the GCP
`observability-stack` VM.

- GCP project: `teable-666`
- VM: `observability-stack` in `us-central1-a`
- Static IP: `136.119.178.56`
- Jaeger UI/API: `http://136.119.178.56:16686`
- OTLP HTTP endpoint: `http://136.119.178.56:4318/v1/traces`
- OTLP gRPC endpoint: `http://136.119.178.56:4317`

The service is managed by Docker Compose files under `/opt/monitoring`:

- `/opt/monitoring/docker-compose.yml` keeps the existing Grafana and InfluxDB
  services.
- `/opt/monitoring/docker-compose.jaeger.yml` adds `teable-perf-jaeger` with
  Badger persistence under `/opt/monitoring/jaeger-data`.

Useful checks:

```bash
gcloud compute ssh observability-stack --zone us-central1-a --command \
  'cd /opt/monitoring && sudo docker compose -f docker-compose.yml -f docker-compose.jaeger.yml ps'

curl -fsS http://136.119.178.56:16686/api/services
```

The GitHub workflow sets both `OTEL_EXPORTER_OTLP_ENDPOINT` and
`TRACE_LINK_BASE_URL` to this service. Teable result rows use the `Trace URL`
field to link to the primary trace for each case/engine result.

## When Jaeger is unavailable (temporary measure)

**Status: `teable-perf-jaeger` is deliberately shut down as of 2026-07-31.**

The report job probes `GET /api/services` before publishing selected traces. If
Jaeger does not answer, the run does **not** fail:

- trace publication is skipped,
- every trace manifest is reconciled to `traceFetchBreakerState: "hard-outage"`,
- the run summary carries the "Trace 服务不可用" card,
- the perf results themselves are reported and gated as usual.

Raw trace evidence is unaffected — execute jobs spool it to their own GitHub
artifacts and never talk to shared Jaeger.

A Jaeger that _answers_ the probe but then loses traces is still a hard failure,
because that is a trace-capture regression rather than an outage.

This exists because the publish step used to abort on the first trace and the
workflow scored that as a full-run failure — 11 consecutive red runs over ~30
hours with perfectly good perf numbers. See `framework/jaeger-availability.ts`
for what to revisit once the service is back.
