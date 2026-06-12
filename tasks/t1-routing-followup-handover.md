---
owner: Performance Lab
tags:
  - audit
  - routing
  - handover
enabled: true
---

# T1 Routing Follow-Up Handover

## PR Note

This T1 follow-up rebases the routing assertions over T4's request-only metric
window split. The primary record-create, record-update, and record-reorder
metrics still stop at the request response, while `verifyRowCountMs`,
`verifyUpdatedMs`, and `verifyReorderMs` remain separate verification metrics.
Routing assertions run on the response headers after the timed request returns,
so a V1/V2 mismatch still fails the case without folding verification reads
back into the threshold metric.

Record-reorder cleanup now also asserts routing through the same helper using
the env-derived engine context (`PERF_LAB_ENGINE ?? "local"`). That context is
the same source used by the e2e run context for each sub-run. If cleanup routing
fails in a reusable local seed, the existing cleanup catch path treats the
restore as failed, deletes the cached seed table, and the next run reseeds
instead of turning the cleanup issue into a hard test failure.
