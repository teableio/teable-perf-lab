# Stress tooling

Runnable before the staging environment exists. Tools are dependency-free Node 22+ / Python 3.9+.

```bash
node --test stress-tests/test/tools.test.mjs
node --test stress-tests/test/convergence-gate.test.mjs
```

AWS account safety, provisioning, IAM, loadtest samplers, and the runtime runbook
live in `teableio/teable-infra/scripts/loadtest/` and
`teableio/teable-infra/docs/loadtest-teabledev-access-and-byodb-provisioning.md`.
This repository does not own cloud credentials or AWS-mutating commands. New
runs use TeableDev `716189571018`, private RDS DNS + `sslmode=verify-full`, and
no public IP/SSH/world ingress.

## preflight

Read-only checks for a target table/view/token.

```bash
BASE_URL=https://staging.example.com TEABLE_TOKEN=... \
TABLE_ID=tbl... VIEW_ID=viw... API_KIND=v1 \
node stress-tests/tools/preflight.mjs --json
```

Checks table metadata, a one-row list, and the view. Exit code 0 only if all required checks pass. Never writes.

## convergence-gate

Waits for the customer-DB computed outbox to drain before a timed step. The SQL is caller-supplied; [`sql/computed-outbox-convergence.sql`](sql/computed-outbox-convergence.sql) is the product-schema contract.

```bash
export BYODB_DSN='postgresql://<user>:<password>@<private-rds-dns>:5432/<db>?sslmode=verify-full'
node stress-tests/tools/convergence-gate.mjs \
  --schema space_<id> \
  --sql-file stress-tests/tools/sql/computed-outbox-convergence.sql \
  --psql 'psql "$BYODB_DSN" -X -q -A -t -v ON_ERROR_STOP=1' \
  --interval-ms 5000 --window-ms 120000 --cap-ms 900000 \
  --json-out stress-tests/out/gate-<RUN_ID>.json
```

Criteria: backlog, due, active, stale, seed-origin tasks, and dead letters are zero; oldest age is below 5 seconds for the full two-minute window. Exit 0 means converged; exit 2 means inconclusive. The JSON trail records every sample, duration, and backlog trajectory.

```bash
node --test stress-tests/test/convergence-gate.test.mjs
```

## business-data

Creates realistic linked datasets through the API. Choose a domain and adjust volume:

```bash
BASE_URL=https://staging.example.com TEABLE_TOKEN=... TEABLE_BASE_ID=bse... \
node stress-tests/tools/business-data.mjs --domain crm \
  --customers 2000 --orders-per-customer 8 --items-per-order 3 --products 200
```

| Domain | Tables | Main knobs |
| --- | --- | --- |
| `crm` | Products, Customers, Contacts, Orders, OrderItems | `--products`, `--customers`, `--contacts-per-customer`, `--orders-per-customer`, `--items-per-order` |
| `ecommerce` | Products, Customers, Orders, OrderItems, Inventory, Returns | `--products`, `--customers`, `--orders-per-customer`, `--items-per-order`, `--warehouses`, `--return-every` |
| `project` | Teams, Members, Projects, Tasks, TimeEntries | `--teams`, `--members-per-team`, `--projects-per-team`, `--tasks-per-project`, `--entries-per-task` |
| `hr` | Departments, Employees, LeaveRequests, Reviews, Payroll | `--departments`, `--employees-per-department`, `--leave-requests-per-employee`, `--reviews-per-employee`, `--payroll-periods` |

`--scale` scales the root entity only (`customers`, `products`, `teams`, `departments`); child ratios stay fixed. This avoids multiplying every nested count at once.

Computed fields are created where the domain supports them: CRM `NetTotal`/`LineTotal`, ecommerce `NetTotal`/`LineTotal`/`ReorderQty`, project `RemainingHours`/`BillableAmount`, HR `NetPay`. Use `--no-computed` if the environment rejects formula creation.

Data is deterministic and synthetic: weighted statuses, 60% of draws from the top 20% blocks where applicable, mixed Chinese/English notes, bounded monetary values, and coherent dates/links. HR uses `employee<number>@example.test` and contains no phone/ID/bank data.

Outputs:

- `out/<dataset>.schema.json` — table IDs, fields, counts.
- `out/<dataset>.ids.json` — all table record IDs.
- `out/<dataset>.<table>.ids.json` — one array per table for k6 `RECORD_IDS_FILE`.
- `out/<dataset>.workloads.json` — per-table update field, field ID, record IDs file, example payload.
- `out/<dataset>.dataset-record.json` — ready for `压测数据集`.
- `out/<dataset>.summary.json` — counts/checksums.

`--plan` prints counts without network. `--dry-run` prints one sample row per table. `--dataset-id` overrides the generated ID. Default `--max-rows 250000`; pass `--allow-large` only for direct DB/snapshot seeding, not API seeding.


## seed

Creates a table from a dataset manifest and seeds deterministic rows through the record API.

```bash
BASE_URL=https://staging.example.com TEABLE_TOKEN=... TEABLE_BASE_ID=bse... \
node stress-tests/tools/seed.mjs \
  --manifest stress-tests/datasets/small.json \
  --limit 10000 --batch-size 500
```

Outputs:

- `stress-tests/out/<dataset>.ids.json` — record IDs for update/batch scenarios.
- `stress-tests/out/<dataset>.dataset-record.json` — ready to upsert into `压测数据集`.
- stdout checksum and row count.

Manifest `method`:

- `api` — API seeding. Use for small/medium and smoke data.
- `devtools` — use `pnpm --filter @teable/v2-devtools cli mock generate` or direct DB seeding; the tool prints the plan and exits.
- `snapshot` — restore a production-like snapshot; never generate 10M rows through the API.

`--plan` prints the plan without network. `--dry-run` prints sample records without network.

## bundle-from-k6

Converts a k6 summary into a portable evidence bundle. The persistent recorder and verdict gate live in `teableio/teable-perf-lab/scripts/stress/`.

```bash
node stress-tests/tools/bundle-from-k6.mjs \
  --summary summary-read.json --out run-bundle.json \
  --run-id lst_... --env staging --category core --test-type load \
  --scenario-set readmix_v1 --dataset-key ds_small_v1 \
  --scenario-id core.crud.list_plain --scenario record_list \
  --mode shared --repeat 1 --target-rps 50 --code-version abc1234
```

It maps `http_reqs`, `http_req_failed`, `http_req_duration`, `teable_op_duration{op:*}`, `teable_op_failures`, and `dropped_iterations`. It does **not** invent server-side metric windows, conclusions, or trace links. Complete and record the bundle through `teable-perf-lab`.


## C0 workload tools

- `seed-c0.mjs` seeds the C0 record workload through Teable's record API.
- `k6-summary.mjs` converts C0 raw NDJSON and `handleSummary` output into the versioned `c0-k6-summary/v2` artifact consumed by `teable-perf-lab`.
- `c0-breakpoint.js` owns the open-model C0 workload and emits the bounded sampler contract.

Persistent scheduling, verdicts, evidence recording, and analysis live in `teableio/teable-perf-lab/scripts/stress/`. Kubernetes, RDS, SSM, and load-generator adapters live in `teableio/teable-infra/scripts/loadtest/`.

## AI mock provider

OpenAI-compatible mock; never calls a real model.

```bash
PORT=18081 MOCK_TTFT_MS=20 MOCK_LATENCY_MS=80 MOCK_ERROR_RATE=0 \
  node stress-tests/tools/ai-mock-server.mjs

curl -s localhost:18081/stats
```

Routes: `POST /v1/chat/completions`, `GET /v1/models`, `GET /stats`. Supports `stream:true`, simulated usage, and error injection.

Run the k6 AI script against it:

```bash
mkdir -p stress-tests/out
docker run --rm -v "$PWD/stress-tests":/stress -w /stress \
  -e AI_PROXY_URL=http://host.docker.internal:18081/v1/chat/completions \
  -e AI_PROFILE=mock -e AI_REQUESTS=100 -e AI_VUS=10 -e AI_MAX_TOKENS=16 \
  -e SUMMARY_PATH=out/ai-mock.json \
  grafana/k6 run k6/scenarios/ai-proxy.js
```

On Linux, add `--add-host=host.docker.internal:host-gateway` to reach the host mock.

To test the Teable AI Proxy/Gateway with zero real tokens, configure its provider upstream to this mock server, then set `AI_PROXY_URL` to the Teable proxy route (`/api/v1/ai-proxy/v1/chat/completions`) and `AI_PROXY_TOKEN` to an AI proxy JWT.

Real-model canary:

```bash
AI_PROFILE=canary AI_REQUESTS=20 AI_MAX_TOKENS=64 \
AI_PROXY_URL=https://staging.example.com/api/v1/ai-proxy/v1/chat/completions \
AI_PROXY_TOKEN=... \
docker run ... grafana/k6 run k6/scenarios/ai-proxy.js
```

Only after budget approval. The script caps requests, but the budget/token ledger must be enforced outside k6; record `AI预算USD`, `实际AI成本USD`, `总Token数`, `预算状态`.
