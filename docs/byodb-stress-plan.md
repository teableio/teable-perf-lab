# BYODB long-running stress plan

Status: operating plan. This plan extends the deployment-level k6 harness in
`teableio/teable-ee/stress-tests/`; the evidence control plane, deterministic
verdict, analysis, and documentation are owned here. Every measured claim must
join to a canonical scenario and a `Run_ID` in the evidence base.

## Purpose and boundaries

Measure BYODB isolation, capacity, reliability, and cost under multi-tenant,
skewed, and multi-database load. The near-term hypothesis is isolation and a
higher shared-system capacity boundary, not automatically lower single-request
latency.

Ownership is intentionally split:

- Product-facing load generation and API behavior:
  `teableio/teable-ee/stress-tests/k6/`.
- Stress control plane, evidence schema, recording, and analysis:
  `teableio/teable-perf-lab/scripts/stress/`. Raw k6 normalization is produced
  by `teableio/teable-ee/stress-tests/tools/k6-summary.mjs` as the documented
  `c0-k6-summary/v2` document consumed by `scripts/stress/c0-analyze.py`.
- Environment provisioning, deployment, and provider samplers:
  `teableio/teable-infra/scripts/loadtest/`.

This repository does not duplicate provider credentials, cluster commands, or
cloud-specific provisioning steps. Operators use the environment material in
`teableio/teable-infra/scripts/loadtest/` and pass normalized artifacts into the
control plane.

## Falsifiable hypotheses

| ID  | Hypothesis                                                                      | Falsifier                                                                                  | Decision                                                 |
| --- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| H1  | Moving data traffic to BYODB reduces shared meta-DB CPU, connections, or WAL.   | A paired run with at least 50% BYODB traffic improves neither CPU nor connections by 10%.  | Do not sell reduced meta-DB pressure as a benefit.       |
| H2  | A hot BYODB tenant does not worsen a cold/shared tenant's P95 by more than 10%. | The cold/shared P95 rises by more than 10% in a paired run.                                | Tighten per-DB pool budgets or tenant placement.         |
| H3  | Database fan-out first exhausts app connections or memory.                      | Meta-DB CPU crosses its guardrail before pool wait, connections, RSS, or event-loop lag.   | Prioritize the observed saturated layer.                 |
| H4  | BYODB increases shared-system sustainable throughput at a fixed SLO.            | A closed breakpoint differs by less than 10%.                                              | Treat BYODB as isolation/compliance, not capacity.       |
| H5  | A 2–8 hour soak has no monotonic pool, RSS, outbox, or dead-letter growth.      | A significant positive slope remains or the system misses its five-minute recovery window. | Block release and repair lifecycle/convergence behavior. |
| H6  | The measured benefit covers fully observed operating cost.                      | Full-coverage net margin is non-positive.                                                  | Change tier, placement, price, or eligibility.           |

## Variables

Record all variables in the canonical registry row and freeze them for a run:

- deployment spaces `N`; BYODB spaces `M`; BYODB ratio `r=M/N`;
- BYODB traffic share `q`, independent from `r`;
- physical customer databases `D`, PostgreSQL instances `I`, and
  `DB_Per_Instance`, with `D <= I * MAX_DB_PER_INSTANCE`;
- round-robin or hot-skew space-to-database mapping;
- table rows, operation mix, customer/shared DB tier and PostgreSQL version;
- app nodes, ingress resources, `DATABASE_POOL_MAX`,
  `BYODB_DATA_DB_POOL_MAX`, and acquire timeout;
- build/image SHA, feature flags, seed/schema version, load-generator shape,
  RTT source, and observability query version.

A pool is keyed by physical connection identity rather than space. Product code
for this behavior lives at
`teableio/teable-ee/community/apps/nestjs-backend/src/global/data-db-client-manager.service.ts`
and
`teableio/teable-ee/community/packages/db-main-prisma/src/pg-pool-registry.ts`.
Consequently, connection exposure grows with `D * app_nodes * pool_max`, not
with the number of spaces sharing one database.

## Canonical cases

The live scenario registry is authoritative; [the catalog](operations/byodb-stress-case-catalog.md)
is a reviewable snapshot and selection guide.

| ID  | Shape                                        | Purpose                                                     | Cost tier |
| --- | -------------------------------------------- | ----------------------------------------------------------- | --------- |
| C0  | One modal BYODB tenant, breakpoint profile   | Product capacity envelope; initially single-table CRUD only | L2        |
| C1  | Shared-only modal baseline                   | Stable anchor for paired comparisons                        | L1        |
| C2  | 10% BYODB spaces receive 80% of traffic      | Hot-tenant isolation                                        | L1        |
| C3  | 50% BYODB traffic across 10 databases        | Balanced fan-out                                            | L2        |
| C4  | 100 spaces share 10 small databases          | Per-pool multi-space contention                             | L2        |
| C5  | Large formula/computed workload              | Outbox steady state and recovery                            | L3        |
| C6  | High space count and bounded maximum fan-out | Node connection and memory boundary                         | L3        |

Sweep series answer where the knee occurs: `sweep-d` varies physical databases,
`sweep-m` varies spaces per database, `sweep-q` varies BYODB traffic share,
`sweep-shared-db` varies shared DB tier, and `sweep-pods` varies app nodes.
Screening cells may run once; a knee, both adjacent cells, and endpoints require
at least three repeats before a statistical claim.

## Load and breakpoint method

1. Prefer an open `constant-arrival-rate` or `ramping-arrival-rate` model.
2. Use warmup (5–10 minutes), ramp (10 minutes), plateau (30 minutes), ramp-down
   (10 minutes); use 2–8 hours for soak.
3. Evaluate guardrails per minute. Cumulative k6 thresholds are hints, not the
   source of the verdict.
4. Record target and achieved arrival rate, each step's `dropped_iterations`,
   queue/pool wait, and RTT.
5. Repeat canonical cells at least three times and report median, IQR, 95% CI,
   and sample count. P99 requires at least 10,000 successful requests.
6. Interleave paired comparisons A-B-B-A with identical build, seed, topology,
   tiers, pool configuration, and feature flags.

`Max_Passing_RPS` is the highest passing step. `Max_Sustainable_RPS=X` is valid
only when `X` passes 3/3 and its next higher step fails at least 2/3;
`Capacity_Bound=point` then denotes `[X, X_next)`. Otherwise keep
`Max_Sustainable_RPS=null`, set `Capacity_Bound=lower`, and say only
“at least X RPS (lower bound)” with the repeat count.

## Correctness and abort rules

Use a different token or direct SQL to verify sampled IDs and values, row counts,
computed convergence, and permission isolation. Each check records `Delta`,
`Tolerance`, verifier, and sample reference. Missing bounds yield `partial`, not
`pass`.

Abort on any per-minute guardrail breach: error rate above 1%; P99 above twice
the scenario SLO; persistent acquire timeout; pool connections above 80% of
configured limit; `dropped_iterations > max(10, 1% of requests)`; outbox oldest
age above five minutes; an environment DB/app guardrail; or an invalid `I/D`
budget. Preserve the breach window, collect at least five recovery minutes, and
still run cleanup. The verdict is `aborted`.

## Required measurements

- Per-operation client P50/P95/P99/P99.9, error class, achieved RPS, and dropped
  iterations.
- Shared and customer DB CPU, active connections, TPS, WAL, locks, and IO.
- Pool connections, waiting, limit, references, acquire duration/timeouts,
  grouped by node and database.
- App CPU, RSS, GC, and event-loop lag.
- Computed outbox backlog, oldest due age, workers, dead letters, and recovery.
- Independent correctness checks, per-resource cleanup receipts, and measured
  RTT.

Missing telemetry is `null` plus `no_data` or `source_error`; it is never zero.
Merge histogram buckets before computing cross-pod percentiles; never average
percentiles.

## Cost model

Keep prices as explicit versioned inputs. For each run, observe DB, app-node,
load-generator, observability, and operations usage. Calculate customer DB cost,
one-time deployment amortization, support/observability cost, and any measured
shared-tier scale-up deferral separately. Report `cost_per_10k_ops`, net margin,
break-even ratio, and capacity delta only when every required input is present.
The pre-run `Est_Run_Cost` selects work within budget; post-run actuals never
overwrite it.

## Delivery phases

1. **Schema/control plane:** canonical registry, versioned configs, evidence
   keys, gate, bundle recorder, and cleanup receipts.
2. **C0/C1 proof:** smoke, independent correctness, a closed repeated C0
   ladder, and an identically controlled shared baseline.
3. **Isolation/fan-out:** C2–C6 plus `sweep-d/m/q`, pool and per-instance
   telemetry, and knee confirmation repeats.
4. **Cost/soak:** calibrated full-coverage cost, 2–8 hour recovery evidence,
   shared-tier/pod sweeps, and telemetry-derived tenant profiles.
5. **Recurring regression:** budget-selected runs, 28-day compatible baselines,
   evidence-completeness gates, and retained query/report receipts.

Each phase is complete only when its evidence is queryable by canonical
identity, cleanup is verified per resource, and every claimed number can be
recomputed from structured rows.

## Evidence and reporting gates

The schema, idempotency keys, write order, and deterministic verdict are defined
in [the evidence contract](operations/byodb-stress-evidence-contract.md).
Operational execution follows [the runbook](operations/byodb-stress-runbook.md).
Read results with [the report guide](operations/byodb-stress-report-guide.md).

A publishable run contains joined run, per-operation result, metric-window,
correctness, resource-lifecycle, cost, and report-artifact rows. Charts read
structured columns only. A run with incomplete cleanup, an upgraded human
verdict, a legacy/non-canonical scenario identity, or a missing query receipt is
not evidence for a claim.

Cost is publishable only with `Cost_Coverage=full`: DB, app-node, load-generator,
and operations components observed, currencies explicit, and any conversion
carrying `FX_Rate` plus `FX_AsOf`. A partial component sum is not total cost.

## Security and environment handoff

Secrets remain in environment variables or the repository-approved secret
store and must never be printed or placed in a bundle. Test-only TLS or SSRF
concessions are recorded verbatim in the environment baseline. Provisioning,
network access, provider cleanup, and provider-specific metrics are supplied by
`teableio/teable-infra/scripts/loadtest/`; this repository consumes only the
normalized outputs and per-resource receipts.
