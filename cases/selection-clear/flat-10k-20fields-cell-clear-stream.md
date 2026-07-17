---
owner: backend-v2
tags:
  - selection-clear
  - stream
  - table-operation
  - 10k
  - v1-v2
  - 20fields
enabled: true
---

# selection-clear/flat-10k-20fields-cell-clear-stream

## Goal

Measure clearing every visible cell in a 10,000-row, 20-field mixed grid and
catch nonlinear regressions beyond the existing 1k stream baseline.

## Seed Phase

Create the same deterministic mixed-field table as the 1k case, scaled to
10,000 rows and seeded in 1,000-row batches. Resolve the grid view and visible
field projection before measurement.

## Execute Phase

Clear the full grid selection through the endpoint used by each engine's UI:
V1 uses the range stream and V2 uses the by-id stream with
`selection.allRecords`. Consume the SSE response through its final `done` event.

## Primary Metric

- `clear10kMs`: request start until the clear stream emits `done`.

Seed preparation, the post-clear full scan, and local cleanup stay outside the
primary timer. The initial 60-second guardrail is intentionally wide until
local and CI history establishes the 10k envelope.

## Verification

- Routing headers must match the requested V1/V2 engine.
- The stream must report 10,000 processed rows.
- All 10,000 rows must remain present.
- A paged full scan must prove every projected cell is empty.

## Notes

This is a scale companion to the 1k case, not a different endpoint benchmark;
both cases preserve the same grid-visible behavior per engine.
