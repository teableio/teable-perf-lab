# BYODB stress runbook

Use this recipe after selecting a live canonical row from
[the case catalog](byodb-stress-case-catalog.md). Product load scripts are owned
by `teableio/teable-ee/stress-tests/`; provider and deployment procedures are
owned by `teableio/teable-infra/scripts/loadtest/`; this repository owns schema,
analysis, deterministic verdicts, and evidence writes.

## Prepare

1. Read the live registry row. Require an eligible lifecycle status and freeze
   its immutable `Scenario_ID` and `Spec_Version`.
2. Confirm previous runs in the environment have
   `Cleanup_Status=verified` and there are no orphan resources.
3. Allocate `Run_ID=lst_<utc>` and `Repeat`; freeze build/config, topology,
   pool settings, tiers, database mapping, seed version, RTT source, and SLOs.
4. Obtain environment and provision receipts using
   `teableio/teable-infra/scripts/loadtest/`. Keep credentials in approved
   environment variables and do not print connection URLs or tokens.
   AWS steps are additionally gated by
   `teableio/teable-infra/scripts/loadtest/aws_safety.py require-account`.
   Default account is TeableDev `716189571018`; production is never
   approvable; any other account requires a named approval file. The gate is
   procedural: run it before the first mutation, then `aws-preflight` on the
   live resources. Full runbook:
   `teableio/teable-infra/docs/loadtest-teabledev-access-and-byodb-provisioning.md`.
5. Preflight every customer database from the target application environment.
   Require `ok=true` and classification `empty` for first binding or
   `teable-managed-compatible` for reuse.
6. Provision spaces/bases/tables through the supported product APIs documented
   by `teableio/teable-ee/stress-tests/`; the application does not provision a
   PostgreSQL database.
7. Seed deterministic data, verify counts directly, and checksum every generated
   k6 input. Empty sampled IDs are a hard failure.

## Execute

Run a smoke profile first. Before each timed step, pass the convergence gate:
customer-DB computed outbox backlog, due, active, stale, seed-origin, and dead
letter counts are zero, and oldest age is below five seconds for two consecutive
minutes. A 15-minute timeout is `inconclusive`; do not start the timed step.

The k6 command and scenario path come from
`teableio/teable-ee/stress-tests/`. Always set an explicit target environment,
canonical run/scenario identity, profile, arrival rate, and duration. Do not put
secrets on the command line or in saved output.

Collect per-step raw k6 summary, service telemetry, correctness samples, and
provider metrics. Raw k6 output is normalized beside the load scenario by
`teableio/teable-ee/stress-tests/tools/k6-summary.mjs`, producing the documented
`c0-k6-summary/v2` document. Preserve that normalized document in the bundle;
do not reimplement the normalizer here.

## C0 analysis inputs

Analyze a normalized k6 document without giving the analyzer cloud credentials:

```bash
SIGNOZ_API_KEY="$SIGNOZ_API_KEY" python3 scripts/stress/c0-analyze.py \
  --run-id lst_<utc> \
  --k6 <c0-k6-summary-v2.json> \
  --step <step-name> --target <rps> \
  --start <iso-start> --end <iso-end> \
  --signoz-url "$SIGNOZ_URL" \
  --signoz-service "$SIGNOZ_SERVICE_NAME" \
  --db-namespace "$SIGNOZ_DB_NAMESPACE" \
  --rds-metrics <normalized-rds-metrics.json> \
  --db-samples <db-samples.jsonl> \
  --step-interval 60 \
  --out <analysis.json>
```

`--k6` accepts `c0-k6-summary/v2` or a raw dump. SigNoz URL, service, and DB
namespace must be supplied by their flags or `SIGNOZ_URL`,
`SIGNOZ_SERVICE_NAME`, and `SIGNOZ_DB_NAMESPACE`; authentication uses
`SIGNOZ_API_KEY`. There are no production defaults. The analyzer never invokes
the AWS CLI.

`--run-id` is the canonical `lst_<utc>` identity; it must match the k6
document, RDS metrics, and evidence bundle. `--db-samples` accepts PostgreSQL
sample JSONL emitted by
`teableio/teable-infra/scripts/loadtest/samplers/db-sampler.sh`.

`--rds-metrics` accepts the provider-neutral JSON document produced by
`teableio/teable-infra/scripts/loadtest/collect-rds-metrics.py`, or any producer
of the same normalized shape. That producer is invoked with its run/step
provenance inputs (`--run-id <id> --step <step>`) and must emit those exact
values as the top-level `run_id` and `step`; the analyzer rejects a document
whose provenance does not match the requested run and step.

```json
{
  "run_id": "lst_<utc>",
  "step": "s20",
  "status": "ok",
  "error": null,
  "instance": "customer-db-1",
  "region": "test-region",
  "instanceStatus": "available",
  "metrics": {
    "CPUUtilization": {
      "status": "ok",
      "error": null,
      "statistic": "Average",
      "unit": "Percent",
      "points": [{ "ts": "2026-10-26T00:00:00Z", "value": 12.1 }]
    }
  }
}
```

Top-level and per-metric `status` accept exactly `ok`, `no_data`, or
`source_error`; `error` may explain `no_data` or `source_error`, and missing
points are `no_data` rather than zero.

## Abort and cleanup

Abort immediately on a guardrail listed in
[the plan](../byodb-stress-plan.md). Preserve the violating minute, collect at
least five recovery minutes, and set verdict `aborted`.

Cleanup runs in `finally` semantics even after an abort. Delete records, tables,
bases, spaces, customer databases/instances, network resources, subscriptions,
and load generators created by the run. Re-list each resource through its
owning provider or API. Store one lifecycle row per resource with its own
`Receipt_JSON`, `Deletion_Evidence_Code`, and
`Deleted_At_Source=per-resource-receipt`. A survivor or generic batch receipt is
`cleanup_failed`.

## Record

Perform correctness reads with a different token or direct SQL. Write `Delta`,
`Tolerance`, verifier, sample reference, and permission-isolation result.
Finalize the bundle only after correctness and cleanup, then preview/enforce the
gate and record it:

```bash
node scripts/stress/record-run.mjs --bundle <run-bundle.json>
node scripts/stress/check-evidence-keys.mjs
```

The [evidence contract](byodb-stress-evidence-contract.md) defines the exact
rows and verdict. Use [the report guide](byodb-stress-report-guide.md) before
publishing a claim.
