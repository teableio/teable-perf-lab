# BYODB stress case catalog

The live `压测场景目录` table (`tbltNQJdOam0wabQreT`) is authoritative. This
document defines stable identities and selection policy; read the live row and
verify `Spec_Version`, lifecycle status, and numeric constants before a run.
Percent-formatted API fields store fractions (`80%` is `0.8`). An absent or zero
uncalibrated estimate does not mean a free run.

## Canonical suite

| Scenario | Stable intent                          | Required comparison                          |
| -------- | -------------------------------------- | -------------------------------------------- |
| `C0`     | Modal single-BYODB-tenant breakpoint   | Higher failing step needed to close capacity |
| `C1`     | Shared-only modal anchor               | Same build/topology as BYODB pair            |
| `C2`     | Hot-tenant isolation, `r=10%`, `q=80%` | Cold/shared tenants in same run              |
| `C3`     | Balanced half-BYODB fan-out            | C1 under identical shared resources          |
| `C4`     | Many spaces sharing a bounded DB set   | Per-DB pool and cold/hot P95 spread          |
| `C5`     | Large formula/computed steady state    | Outbox recovery and dead letters             |
| `C6`     | High-space, maximum-budget fan-out     | Node connection/RSS budget                   |

`C0-loadtest-*`, dates, worker names, and step labels are `Scenario_Label`
values, never scenario identities.

## Sweep families

- `sweep-d-{1,2,5,10,20}`: physical database count and pool fan-out.
- `sweep-m-{1,5,20,50}`: spaces per database and noisy-neighbor contention.
- `sweep-q-{0,25,50,75,100}`: BYODB traffic share and shared meta-DB relief.
- `sweep-shared-db`: shared DB tier capacity envelope.
- `sweep-pods`: app-node scaling and per-node connection exposure.
- `sh-<tier>-p<pods>`: explicit shared-tier × app-node grid cells.
- `profile-p50`, `profile-p90`, `profile-p99`: telemetry-derived tenant shapes;
  do not execute while blocked or synthetic-only.

A screening sweep cell may run once. Promote the detected knee, both adjacent
cells, and endpoints to at least three repeats with CI.

## Lifecycle and budget selection

Eligible lifecycle statuses are `planned`, `passed`, and `failed`; `passed`
remains part of recurring regression. `running` is already claimed. Never run
`blocked`, `untested-budget`, `untested-excluded`, or `legacy-archive`.

Schedule every affordable row in ascending estimated cost while always retaining
C1 and C0. Under a budget reduction, drop L3 before L2 and preserve L1 plus C0.
Reject a row before provisioning when `I > MAX_PHYSICAL_DBS` or
`D > I * MAX_DB_PER_INSTANCE`.

## Live registry read

Use the configured non-production Teable instance and a PAT held outside the
repository:

```bash
curl -sS -H "Authorization: Bearer $PAT" \
  "$TEABLE_URL/api/table/tbltNQJdOam0wabQreT/record?take=100"
```

Verify every live `Scenario_ID` appears exactly once. The run bundle copies the
selected row's canonical ID, immutable spec version, SLOs, factors, cost tier,
and profile source. It must not silently override registry values.

See [the plan](../byodb-stress-plan.md) for factor semantics and
[the runbook](byodb-stress-runbook.md) for execution.
