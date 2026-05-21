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
field to link to the primary trace for the matrix job.
