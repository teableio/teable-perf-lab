---
owner: backend-v2
tags:
  - field-restore
  - date
  - trash
  - 10k
  - v1-v2
enabled: true
---

# field-restore/10k-start-date-field

## Goal

Measure restoring a populated date field, its formatting metadata, and all
10,000 serialized date values from field trash.

## Seed Phase

Create the standard deterministic 10k mixed table. `Start Date` advances through
a stable 365-day UTC sequence and carries the shared date formatting options.

## Execute Phase

Delete `Start Date` as setup, resolve its trash item, then measure V1 direct
restore or the V2 restore-field stream through completion.

## Primary Metric

- `restoreFieldMs`: restore request/stream start until completion.

Delete setup and full-scan verification remain outside the primary timer. The
initial 120-second guardrail will be tightened after runtime history.

## Verification

- Delete and restore routing must match the engine.
- The restored field id, name, and date metadata must be readable.
- Every restored cell must match the deterministic date sequence.

## Notes

Date serialization and formatting make this a distinct restore family from text
and single-select values.
