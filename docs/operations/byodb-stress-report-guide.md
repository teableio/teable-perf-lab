# BYODB stress report guide

Use this guide to read and publish BYODB stress evidence. The authoritative
schema and verdict rules are in [the evidence contract](byodb-stress-evidence-contract.md).

## Reading order

Read `registry → run → per-operation result → metric windows → correctness →
resource lifecycle → cost → report artifact`.

1. Registry: canonical identity, immutable spec, status, constants, and SLOs.
2. Run: execution state versus gate-derived verdict, environment/build,
   breakpoint row kind, cleanup, and cost coverage.
3. Results: P50/P95/P99, errors, correctness, sample count, and CI per operation.
4. Metric windows: confirm `observed`; distinguish `no_data` from zero.
5. Correctness: require independent verifier, `Delta`, `Tolerance`, and sample.
6. Resources: require a unique receipt and verified deletion for every resource.
7. Cost: quote totals only when coverage is full.
8. Report artifact: require query receipt, source tables, data hash, generated
   time, and `Status=ok`.

## Field traps

- `状态` is execution state; `判定` is derived evidence disposition.
  `partial` is not pass, and a guardrail breach is `aborted`.
- Run/result success and error rates use 0–100 points. Registry
  percent-formatted fields use 0–1 fractions.
- Percentiles are per `Operation_Key`. Merge histogram buckets across pods;
  never average percentiles or combine breakpoint steps.
- `Max_Sustainable_RPS` requires a failing successor and repeated pass/fail
  evidence. Otherwise report `Max_Passing_RPS` as a lower bound.
- `Correctness=pass` requires independent read-back and non-null bounds.
- An unchecked checkbox may be null. Query missing cleanup explicitly rather
  than treating null as false.
- A partial sum of known cost components is not `Actual_Run_Cost`.
- `Scenario_Label` is display-only. Group and join by canonical `Scenario_ID`
  and `Spec_Version`.

## Red flags

Downgrade or reject a conclusion when any of these occurs:

- unclassified error rate above 1% or P99 above twice SLO;
- persistent pool waiting/acquire timeouts or dropped arrival iterations;
- mixed build, environment, ingress, DB tier, seed, or feature flags in a pair;
- fewer than three repeats or missing CI for a statistical/capacity claim;
- legacy/non-canonical identity or a spec mismatch;
- missing one of the seven required evidence row types;
- correctness marked pass without bounds and independent verification;
- cleanup failure, batch-stamped deletion time, or reused generic receipt;
- estimated-only or partial cost presented as total cost/margin;
- a human verdict less severe than the deterministic gate;
- charts sourced from long text, handwritten numbers, or averaged percentiles.

## Valid claims

A single complete run can demonstrate that a path worked, data landed in the
customer DB, independent correctness checks passed, and provisioned resources
were individually removed.

A capacity or BYODB-versus-shared benefit claim requires at least three repeats,
CI, a 30-minute plateau, comparable topology, service telemetry, and a closed
breakpoint ladder. A cost/margin claim additionally requires calibrated prices
and `Cost_Coverage=full`.

For a lower bound, use this form:

> C0 passed X RPS under `<spec>` in N repeats; capacity remains at least X RPS
> (`Capacity_Bound=lower`) because no qualifying higher failing step exists.

Do not shorten it to “capacity is X RPS.”

## Required report structure

A publishable report contains, in order:

1. `Run_ID`, canonical `Scenario_ID`, `Spec_Version`, `Repeat`, `Mode`, build SHA,
   and config URI/digest.
2. Environment/topology: app and ingress, shared/customer DB tier and version,
   pool settings, mapping, RTT, and explicit test-only security concessions.
3. Load profile: model, target/achieved RPS, phase duration, and dropped
   iterations per step.
4. Per-operation headline values with sample count, CI, errors by class, and
   capacity-bound semantics.
5. Independent correctness evidence.
6. Estimated versus actual cost components and coverage.
7. Per-resource cleanup receipts.
8. Limitations preserved verbatim from the run.
9. Gate-derived verdict and next decision.
10. The report-artifact row, query receipt, source tables, and data hash.

Every conclusion sentence must resolve to a structured row and its source
window/receipt. Delete a sentence that cannot.

## Query policy

Filter out `legacy-archive` and rows with null `Mode`, `Repeat`, or canonical
`Scenario_ID`. Group the rolling baseline by
`Scenario_ID + Spec_Version + Mode + Operation_Key` and compare only compatible
environment fingerprints. Charts use structured numeric/date/select/link
fields. See [the API reference](byodb-stress-teable-evidence-api.md) for table
IDs and safe request patterns.
