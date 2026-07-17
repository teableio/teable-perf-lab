---
owner: backend-v2
tags:
  - record-read
  - pagination
  - lookup
  - formula
  - 50k
  - 50fields
  - v1-v2
enabled: true
---

# record-read/50k-50fields-50x1k-pages

## Goal

Measure a complete 50,000-row read through fifty 1,000-row pages while
projecting 50 fields, including 20 lookups and five formulas.

## Seed Phase

Reuse the 10k case's deterministic source/host topology at 50k scale: 20 simple
text fields, 20 lookups, five formulas, and the fixed permutation. Wait for all
computed values before measurement.

## Execute Phase

Read fifty consecutive 1,000-row pages with the same 50-field projection and no
explicit filter, sort, or group clauses.

## Primary Metric

- `getRecords50kPagedScanMs`: total elapsed time for the fifty page requests.

Computed seed readiness and post-read evidence checks remain outside the primary
timer. The initial 60-second guardrail will be calibrated from runtime history.

## Verification

- Every page must respect the expected bounds and projection.
- Exactly 50,000 records must be scanned.
- First, boundary, middle, and last samples must match deterministic lookup and
  formula values.
- Routing must match feature `getRecords` on both engines.

## Notes

Page size remains fixed at 1,000, so comparison with the 10k sibling isolates
total table scale rather than request width.
