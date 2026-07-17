---
owner: backend-v2
tags:
  - duplicate-view
  - grid-view
  - metadata
  - p95
  - v1-v2
enabled: true
---

# duplicate-view/complex-grid-20fields-p95

## Goal

Cover the distinct `duplicateView` canary route and track p95 latency for a real
grid view carrying filters, sorts, grouping, and 20 fields of column metadata.

## Seed Phase

Create one empty 20-field mixed table. Add a dedicated grid view with three
filters (`Title`, `Amount`, `Status`), two sort clauses, one category group, and
deterministic width/order/visibility metadata for every field. Records are
intentionally absent because both product implementations duplicate view
metadata rather than table data.

## Execute Phase

Duplicate the original source view once as warmup, then duplicate that same
original 30 times independently. Measure each POST request and preserve the
first/last routing evidence.

## Primary Metric

- `duplicateViewP95Ms`: p95 of the 30 measured duplicate requests.

Warmup, seed construction, final metadata verification, and cleanup are outside
the metric. The initial 2-second guardrail is wide for a new metadata case and
will be tightened after runtime history.

## Verification

- Every duplicate response must be HTTP 201.
- V1/V2 routing must match feature `duplicateView`.
- All 31 created views must preserve the original type, filter, sort, group, and
  column metadata.
- The original source view must remain unchanged.

## Notes

Repeated samples improve measurement stability without changing the semantics
of one user-triggered duplicate operation; every request copies the same
original source view.
