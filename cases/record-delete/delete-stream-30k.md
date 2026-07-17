---
owner: backend-v2
tags:
  - record-delete
  - stream
  - selection
  - 30k
  - v1-v2
enabled: true
---

# record-delete/delete-stream-30k

## Goal

Extend the 1k/10k selection-delete stream curve to a 30,000-row workload that
can expose nonlinear row-deletion and stream-progress regressions.

## Seed Phase

Create one deterministic 30,000-row mixed table in 1,000-row batches and verify
the first, middle, and last records before execute.

## Execute Phase

Delete the complete grid selection through the endpoint used by each engine's
UI. V1 drives the legacy range stream; V2 drives the by-id stream with
`selection.allRecords`. Read the stream until its final `done` event.

## Primary Metric

- `deleteStream30kMs`: request start through the final delete `done` event.

Seed build and the final empty-table verification are diagnostics outside the
primary timer. The initial 120-second guardrail will be tightened after runtime
history.

## Verification

- Routing must match V1/V2 and feature `deleteRecord`.
- The stream must report 30,000 deleted records without business errors.
- The table must contain zero visible records after completion.

## Notes

The workload keeps the same UI behavior and schema as the 10k sibling; only row
scale changes.
