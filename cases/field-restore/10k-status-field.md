---
owner: backend-v2
tags:
  - field-restore
  - single-select
  - trash
  - 10k
  - v1-v2
enabled: true
---

# field-restore/10k-status-field

## Goal

Measure restoring a populated single-select field and all 10,000 option-backed
cell values from field trash.

## Seed Phase

Create the standard deterministic 10k mixed table. `Status` cycles through
`Todo`, `Doing`, and `Done`; confirm sample values before execute.

## Execute Phase

Delete `Status` as setup, resolve its trash item, then measure V1 direct restore
or the V2 restore-field stream through completion.

## Primary Metric

- `restoreFieldMs`: restore request/stream start until the engine reports
  completion.

Delete setup and the post-restore full scan are diagnostics outside the timer.
The initial 120-second guardrail is intentionally wide pending runtime history.

## Verification

- Delete and restore routing must match the engine.
- The same field id and name must reappear.
- All 10,000 restored select values must match the deterministic cycle.

## Notes

This complements the existing long-text case by exercising option-backed cell
serialization.
