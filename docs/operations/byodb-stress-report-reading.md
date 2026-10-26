# BYODB stress report-reading reference

This is the short operator reference. Use the full
[report guide](byodb-stress-report-guide.md) for publication and the
[evidence contract](byodb-stress-evidence-contract.md) for schema/gates.

## Read in order

`registry → run → result → metric windows → correctness → resource lifecycle → cost → report artifact`

| Step        | Gate                                                                                |
| ----------- | ----------------------------------------------------------------------------------- |
| Registry    | Canonical `Scenario_ID`, matching `Spec_Version`, eligible lifecycle status         |
| Run         | State and derived verdict agree; environment frozen; cleanup/cost coverage explicit |
| Result      | One row per operation; samples and CI support the claimed statistic                 |
| Metrics     | `observed` or explicit `no_data/source_error`; missing is never zero                |
| Correctness | Independent verifier plus non-null `Delta` and `Tolerance`                          |
| Resources   | Every resource has an individual deletion receipt                                   |
| Cost        | Quote totals only at `Cost_Coverage=full`                                           |
| Report      | Query receipt, source tables, data hash, generated time, `Status=ok`                |

## Fast traps

- Run/result percentages are 0–100 points; registry percentages are 0–1.
- Merge histogram buckets; never average P95/P99.
- `Repeat=1` is a point observation, not a capacity conclusion.
- Without a failing successor, say “at least X RPS (lower bound)” and leave
  `Max_Sustainable_RPS` null.
- `Scenario_Label` is never a join key.
- Null cost is unknown, not free.
- `Cleanup_Status=verified` requires every resource receipt.
- A person may only make the deterministic verdict stricter.

A report missing any required evidence class, canonical identity, limitations,
or report receipt is invalid for conclusions and charts.
