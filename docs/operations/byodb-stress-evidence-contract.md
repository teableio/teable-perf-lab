# BYODB stress evidence contract

This contract defines the normalized evidence model, idempotency keys, write
order, and report gate for deployment-level BYODB stress tests. The evidence
base is `bseI12UcCPjJ9bnoGlQ` on the configured non-production Teable instance.
Do not embed a PAT or assume a production URL.

## Tables and grain

| Table            | ID                    | One row represents                                                 | Evidence key                                                                                          |
| ---------------- | --------------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| 压测场景目录     | `tbltNQJdOam0wabQreT` | Immutable `(Scenario_ID, Spec_Version)` definition                 | `scenario:<scenario_id>`                                                                              |
| 压测数据集       | `tblBlNbg5SvNXjmIcE9` | Reproducible dataset version                                       | `ds:<dataset_id>`                                                                                     |
| 压测运行         | `tblpOfmLQ0oF7VBd0RG` | One execution, or one breakpoint umbrella/step                     | `lst:<run_id>`                                                                                        |
| 压测场景结果     | `tblekRdSzxaSnWrI8Ef` | `(Run_ID, Scenario_ID, Spec_Version, Repeat, Mode, Operation_Key)` | `lst:<run_id>:scenario:<scenario_id>:<mode>:<repeat>[:<operation>]`                                   |
| 压测指标窗口     | `tblBOkY7Coe7nEE5XNJ` | One metric/operation/instance/window                               | `lst:<run_id>:metric:<metric>:<scenario_id>:<window_start_ms>[:op=<op>][:db=<role>][:instance=<key>]` |
| BYODB 成本估算   | `tbl29K7mcnlRWActQ6O` | One estimated/actual cost component                                | `lst:<run_id>:byodb-cost:<scenario_id>:<component>[:mode=<mode>][:repeat=<n>]`                        |
| 压测资源生命周期 | `tblhbgQi86tNHPSgRLd` | One provisioned resource and deletion receipt                      | `lst:<run_id>:resource:<resource_key>`                                                                |
| 压测正确性检查   | `tblor6okhLRPq3y6fW7` | One independently repeatable check                                 | `lst:<run_id>:check:<check_key>[:scenario=<sid>][:mode=<mode>][:repeat=<n>][:op=<op>]`                |
| 压测报告产物     | `tblRsIZoJQG6WSQ33CE` | One report or chart version                                        | `report:<report_key>:<report_version>`                                                                |
| 瓶颈与优化       | `tblQ51xVeMHSVoF8bMW` | One trace-backed bottleneck fact                                   | `lst:<run_id>:bottleneck:<sequence>`                                                                  |

The only key generator is `buildEvidenceKey()` in
`scripts/stress/evidence-gate.mjs`. Query `Evidence_Key` before upsert. A case
definition is never overwritten by result facts.

## Common dimensions

- `Scenario_ID` is canonical (`C0`, `C1`, `sweep-d-5`), never an environment,
  date, worker, or run label. Preserve old labels in `Scenario_Label`.
- `Spec_Version` is immutable. Changing a scenario constant creates a new
  version; a run/registry mismatch is `inconclusive`.
- `Repeat` is a positive experimental repeat, not an environment encoding.
- `Mode` is `shared` or `byodb`; do not combine their percentiles.
- `Operation_Key` and `Instance_Key` are controlled dimensions. Use structured
  `all` only when the dimension genuinely does not apply.
- `Key_Version` is `v2` for canonical generated keys; retained historical rows
  may be `v1-drifted`.
- Unknown values are `null`, with `采集状态=no_data` or `source_error`. Zero is a
  measurement, never a missing-value sentinel.

Percent representation is column-specific: percent-formatted registry columns
store fractions from 0 to 1; run/result success and error columns store points
from 0 to 100; metric-window values are raw numbers qualified by `单位`. New
field names use `_Frac` or `_Pct100` to make the representation explicit.

## Breakpoint rows and totals

A breakpoint family has one `Row_Kind=summary` umbrella and one
`Row_Kind=step` run per load step. Each step links to the umbrella through
`Parent_Run_ID` and records `Step_Target_RPS`.

The umbrella contains capacity, resources, cleanup, cost, and report state. It
does not contain request totals or latency percentiles. The only reportable
request total is the sum of step rows. Lifecycle requests from warmup, retries,
or probes belong in a reconciliation receipt and must not be added to the step
total. Percentiles from different steps are never merged.

`Max_Passing_RPS` is the highest passing step. `Max_Sustainable_RPS` remains
null unless the highest passing step passes 3/3 and its next higher step fails
at least 2/3. Only that closed ladder has `Capacity_Bound=point`; every other
ladder has `Capacity_Bound=lower`.

## Required rows for a successful run

Every successful umbrella `Run_ID` has:

1. exactly one run row with environment, build, window, spec, gate verdict,
   cost coverage, and cleanup status;
2. at least one result row for every executed scenario/mode/operation;
3. metric windows covering latency, errors, pool/DB telemetry, and each step's
   dropped iterations, including explicit no-data rows;
4. independent correctness checks with `Delta`, `Tolerance`, `Verifier`, and
   observed/sample evidence;
5. one lifecycle row per provisioned resource, each with its own deletion
   receipt and `Deleted_At_Source=per-resource-receipt`;
6. estimated and actual cost-component rows, retaining nulls for unavailable
   prices or observations;
7. a report-artifact row with `Report_Key`, `Query_Receipt`, `Source_Tables`,
   `Data_Hash`, `Generated_At`, URI, and `Status=ok`.

Finalize in this order: correctness, cleanup verification, actual cost,
deterministic verdict, report. The report and charts read structured fields,
never explanatory long text.

## Deterministic verdict

`scripts/stress/evidence-gate.mjs` derives the verdict. Human review may make it
stricter but may not upgrade it.

| Evidence                                                                                    | Derived outcome |
| ------------------------------------------------------------------------------------------- | --------------- |
| Per-minute guardrail breach, dropped iterations above `max(10, 1%)`, or P99 above twice SLO | `aborted`       |
| Error rate above threshold, correctness failure, or unverified cleanup                      | `fail`          |
| Missing environment/spec attribution, incomplete evidence chain, or partial correctness     | `inconclusive`  |
| All gates pass but breakpoint is only a lower bound                                         | `capacity_only` |
| Complete evidence and all gates pass                                                        | `pass`          |

Severity order is `pass < capacity_only < inconclusive < fail < aborted`.

## Cost and cleanup

`Est_Run_Cost` is written before the run and has `Estimated_At` earlier than
start time. Each component stores one `Currency`. Mixed currencies require an
explicit `FX_Rate` and `FX_AsOf` into `Base_Currency`.
`Cost_Coverage=full` requires observed DB, app-node, load-generator, and
operations components and complete FX data. Otherwise
`Cost_Coverage=partial` and run-level `Actual_Run_Cost` stays null.

Cleanup is per resource, not a batch timestamp. A run has
`Cleanup_Status=verified` only if every lifecycle row has
`Deletion_Verified=true`, a non-empty provider/API receipt, and
`Deleted_At_Source=per-resource-receipt`. Any survivor or absent receipt makes
the run `cleanup_failed` and blocks the next run in that environment.

## Stable field IDs

Field metadata must still be read live before mutation. These established IDs
anchor joins and idempotency:

| Table        | Logical field  | Field ID              |
| ------------ | -------------- | --------------------- |
| 压测运行     | `Run_ID`       | `fldRJPaYl03lim24QGJ` |
| 压测运行     | `Spec_Version` | `fldHRRGqfl9JC5QvlGG` |
| 压测运行     | `Evidence_Key` | `fldpMjsfp2RGPtNtar7` |
| 压测场景结果 | run link       | `fldJoyjbSfMyiUnMknq` |
| 压测场景结果 | `Scenario_ID`  | `fldXMdcfPp80Mt1uuM8` |
| 压测场景结果 | `Spec_Version` | `fldW2HxiQorOQQRmw4f` |
| 压测场景结果 | `Repeat`       | `fldHCJy9weXW7wuJNgm` |
| 压测场景结果 | `Mode`         | `fldZ4i4cDhMFVRWOaeS` |
| 压测场景结果 | scenario link  | `fldd0ufw8dDc9McmM9c` |
| 压测场景结果 | `Evidence_Key` | `fldCzmyKnt8VOIpC7Xt` |

The run link and textual `Run_ID` are distinct concepts. Other normalized tables
use the same logical dimensions; resolve their current IDs through field
metadata and keep `scripts/stress/evidence-schema.mjs` aligned.

## Normalization and recording

Raw k6 output is normalized beside the load scenario by
`teableio/teable-ee/stress-tests/tools/k6-summary.mjs`, which emits the
documented `c0-k6-summary/v2` document. This repository consumes that shape in
`scripts/stress/c0-analyze.py`; it does not produce it.

Record a complete bundle only after correctness and cleanup:

```bash
node scripts/stress/record-run.mjs --bundle <run-bundle.json>
node scripts/stress/check-evidence-keys.mjs
```

For schema/field IDs and API examples, use
[the evidence API reference](byodb-stress-teable-evidence-api.md). For historical
key/identity repair, use [the migration guide](byodb-stress-evidence-migration.md).
