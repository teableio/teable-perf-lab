# Stress test harness

Runnable k6 skeleton for the Teable record API. It generates load, tags requests, and writes a k6 summary JSON; it does **not** seed data, clean up, or decide pass/fail. Those are separate steps so a test cannot silently mutate or hide evidence.

Read `docs/operations/stress-testing-program.md`, `docs/operations/byodb-stress-evidence-contract.md`, and `docs/operations/byodb-stress-runbook.md` first. This repository owns the harness, control plane, and evidence writes; environment adapters live in `teableio/teable-infra`.

## Prerequisites

- A dedicated staging/perf Teable environment. Do not point this at production or a customer BYODB.
- An access token with `record|read`, `record|create`, `record|update`, `record|delete` on the test base.
- A test base with a table, a view, and (for update/delete) a pre-seeded list of record IDs.
- k6 (`brew install k6`) or Docker.
- For `benchmark.vibe-app.xyz`, use the environment contract in `teableio/teable-infra/k8s/teable-loadtest/ack-usw1-test/README.md`; this repository does not own cluster or cloud lifecycle.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `BASE_URL` | `http://localhost:3000` | API origin |
| `TOKEN` | `replace-me` | Bearer access token |
| `TABLE_ID` | `tbl_replace_me` | Test table |
| `VIEW_ID` | empty | View for list queries |
| `API_KIND` | `v1` | `v1` (`/api/table/...`) or `v2` (`/api/v2/tables/...`) |
| `RECORD_IDS_FILE` | `../../data/ids.example.json` | JSON array of record IDs; k6 resolves relative paths from the scenario file |
| `RUN_ID` | `lst_local_smoke_0000000` | Trace/evidence correlation ID |
| `PROFILE` | `smoke` | smoke/load/stress/soak/spike/breakpoint |
| `TARGET_RPS` | `20` | Plateau arrival rate |
| `DURATION` | profile default | Plateau duration (e.g. `30m`, `2h`) |
| `PRE_VUS` / `MAX_VUS` | derived | k6 VU pool |
| `READ_MODE` | `mixed` | list/get/search/mixed |
| `WRITE_MODE` | `cycle` | create/update/delete/cycle/batch_update |
| `MIX` | `read` | read-heavy or write-heavy mix |
| `TAKE` | `100` | List page size (max 1000) |
| `FILTER_JSON` | empty | Raw filter JSON for list queries |
| `SORT_JSON` | empty | Raw sort/orderBy JSON |
| `GROUP_JSON` | empty | Raw groupBy JSON |
| `PROJECTION` | empty | Comma-separated field IDs/names |
| `PAGE_MODE` | `offset` | `offset` or `cursor` |
| `SKIP` | `0` | Offset for deep pagination |
| `CURSOR` | empty | Opaque cursor for `PAGE_MODE=cursor` |
| `INCLUDE_TOTAL` | `false` | Include total count |
| `BATCH_SIZE` | `100` | Rows per batch update |
| `FIELD_NAME` | `Name` | Editable field used for writes |
| `SEARCH_PROBE` | `order` | Search probe |
| `SOURCE_RECORD_ID` | first ID | Source record for computed fan-out |
| `UPDATE_FIELD` | `FIELD_NAME` | Field that triggers computed updates |
| `SUMMARY_PATH` | `summary-<script>.json` | k6 `handleSummary` output |

## Scripts

| Script | Use |
| --- | --- |
| `k6/scenarios/read.js` | list/get/search, open model |
| `k6/scenarios/write.js` | create/update/delete/cycle/batch update |
| `k6/scenarios/computed.js` | update one source record to trigger formula/lookup/rollup |
| `k6/scenarios/mixed.js` | production-like read/write mix |
| `k6/scenarios/ai-proxy.js` | AI Gateway/Proxy mock or small canary; never high-concurrency real model |
| `k6/scenarios/c0-breakpoint.js` | C0 modal-tenant breakpoint workload and external sampler contract |

AI variables: `AI_PROXY_URL`, `AI_PROXY_TOKEN`, `AI_MODEL`, `AI_MAX_TOKENS`, `AI_REQUESTS`, `AI_VUS`, `AI_PROFILE=mock|canary`.

HTTP scripts use `constant-arrival-rate` or `ramping-arrival-rate` and report `dropped_iterations`; a non-zero drop means the generator, not Teable, is the bottleneck. The AI script uses `shared-iterations`/`per-vu-iterations` so a canary has a hard request cap.

## Before the environment exists

Run these rehearsals locally; they do not need staging:

```bash
# 1. tooling tests (mock Teable + mock AI provider)
node --test stress-tests/test/tools.test.mjs

# 2. offline dataset/sample check
node stress-tests/tools/seed.mjs --manifest stress-tests/datasets/small.json --dry-run
node stress-tests/tools/seed.mjs --manifest stress-tests/datasets/large.json --plan

node stress-tests/tools/business-data.mjs --plan --customers 2000 --orders-per-customer 8 --items-per-order 3
node stress-tests/tools/business-data.mjs --dry-run --customers 5 --orders-per-customer 2 --items-per-order 2 --products 8

# 3. k6 syntax/config checks
for f in read write computed mixed ai-proxy; do
  docker run --rm -v "$PWD/stress-tests":/stress -w /stress \
    grafana/k6 inspect "k6/scenarios/$f.js"
done

# 4. AI mock, zero token
node stress-tests/tools/ai-mock-server.mjs &
mkdir -p stress-tests/out
docker run --rm -v "$PWD/stress-tests":/stress -w /stress \
  -e AI_PROXY_URL=http://host.docker.internal:18081/v1/chat/completions \
  -e AI_PROFILE=mock -e AI_REQUESTS=20 \
  -e SUMMARY_PATH=out/ai-mock.json \
  grafana/k6 run k6/scenarios/ai-proxy.js
curl -s localhost:18081/stats
```

When a staging URL/token exists, run `preflight.mjs` first. For realistic CRUD, create a business dataset with `business-data.mjs --domain crm|ecommerce|project|hr` and start small (e.g. 2,000 customers × 8 orders × 3 items). `--scale` scales only the root entity. Then point `RECORD_IDS_FILE` at the generated `<table>.ids.json`; `workloads.json` names the editable field and example payload for each table. The generic `small` manifest is still useful for a fast smoke. The full order is P0 → P6 in the program doc.

## Commands

Run the commands from this directory (`stress-tests`); the container mounts it at `/stress`. The default ID file resolves relative to the scenario file (`../../data/ids.example.json`).

```bash
# Validate scripts without a target
docker run --rm -v "$PWD":/stress -w /stress grafana/k6 inspect k6/scenarios/read.js
docker run --rm -v "$PWD":/stress -w /stress grafana/k6 inspect k6/scenarios/write.js
docker run --rm -v "$PWD":/stress -w /stress grafana/k6 inspect k6/scenarios/computed.js
docker run --rm -v "$PWD":/stress -w /stress grafana/k6 inspect k6/scenarios/mixed.js

# Smoke
BASE_URL=https://staging.example.com TOKEN="$TOKEN" TABLE_ID=tbl... VIEW_ID=viw... \
PROFILE=smoke \
docker run --rm -i -v "$PWD":/stress -w /stress \
  -e BASE_URL -e TOKEN -e TABLE_ID -e VIEW_ID -e PROFILE \
  grafana/k6 run k6/scenarios/read.js

# Load: read-heavy, 50 RPS
BASE_URL=... TOKEN=... TABLE_ID=... VIEW_ID=... \
PROFILE=load TARGET_RPS=50 DURATION=20m API_KIND=v2 \
docker run --rm -i -v "$PWD":/stress -w /stress \
  -e BASE_URL -e TOKEN -e TABLE_ID -e VIEW_ID -e PROFILE -e TARGET_RPS -e DURATION -e API_KIND \
  grafana/k6 run k6/scenarios/read.js

# Write cycle: create -> update -> delete
BASE_URL=... TOKEN=... TABLE_ID=... \
PROFILE=load TARGET_RPS=10 WRITE_MODE=cycle API_KIND=v2 \
docker run --rm -i -v "$PWD":/stress -w /stress \
  -e BASE_URL -e TOKEN -e TABLE_ID -e PROFILE -e TARGET_RPS -e WRITE_MODE -e API_KIND \
  grafana/k6 run k6/scenarios/write.js

# Computed fan-out: update one source record
BASE_URL=... TOKEN=... TABLE_ID=... SOURCE_RECORD_ID=rec... UPDATE_FIELD=Status \
PROFILE=stress TARGET_RPS=5 API_KIND=v2 \
docker run --rm -i -v "$PWD":/stress -w /stress \
  -e BASE_URL -e TOKEN -e TABLE_ID -e SOURCE_RECORD_ID -e UPDATE_FIELD \
  -e PROFILE -e TARGET_RPS -e API_KIND \
  grafana/k6 run k6/scenarios/computed.js

# Mixed read/write
BASE_URL=... TOKEN=... TABLE_ID=... VIEW_ID=... \
MIX=write PROFILE=load TARGET_RPS=20 API_KIND=v2 \
docker run --rm -i -v "$PWD":/stress -w /stress \
  -e BASE_URL -e TOKEN -e TABLE_ID -e VIEW_ID -e MIX -e PROFILE -e TARGET_RPS -e API_KIND \
  grafana/k6 run k6/scenarios/mixed.js
```

With a local k6 install, drop the `docker run` wrapper and run `k6 run ...`.

## Output and evidence

- k6 prints the summary and writes `summary-*.json` (override with `SUMMARY_PATH`).
- For C0, retain raw NDJSON and run `tools/k6-summary.mjs`; its `c0-k6-summary/v2` output is consumed by `scripts/stress/c0-analyze.py`.
- Persistent verdicts, evidence writes, baselines, and reports are owned by this repository under `scripts/stress/`.
- Keep the request's `traceparent`/`baggage`; record representative normal, slow, and error traces with the evidence artifact.

## Safety and cleanup

- Start with `PROFILE=smoke`; increase one profile at a time.
- Abort if `dropped_iterations`, 5xx, pool waiting, or outbox age crosses the run's stop conditions.
- `write.js WRITE_MODE=create` leaves rows behind; delete them by `run_id` or use `cycle`. `mixed.js` creates and deletes in the same iteration for delete traffic.
- Never run this against production without written approval, rate limits, and an operator watching the abort conditions.

## Not included

- Dataset seeding: `tools/seed.mjs` handles `method: "api"` manifests; `devtools`/`snapshot` manifests print a plan for direct DB/template seeding.
- Realtime WebSocket clients: separate harness; see scenario S10.
- Computed convergence verification: query the target fields and compare; the k6 scripts only measure request latency and rely on server-side outbox metrics for convergence.
- AI L0 mock is included: `tools/ai-mock-server.mjs` + `k6/scenarios/ai-proxy.js`. Real-model canary is the same script with `AI_PROFILE=canary`, a hard request cap, and external budget enforcement.
- Wide-table, paste/undo, import/export, realtime, schema-change, share/form, and multi-tenant scenarios are cataloged but need dedicated scripts/UI automation; the catalog marks them `draft`.
- The scenario catalog is table `tbltNQJdOam0wabQreT` (45 rows: 31 core, 10 AI, 4 chaos).
