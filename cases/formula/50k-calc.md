---
owner: backend-v2
tags:
  - formula
  - computed
  - 50k
  - v1-v2
enabled: true
---

# formula/50k-calc

## Goal

Measure creating one formula field and making all computed values readable on a
50,000-row table.

## Seed Phase

Create 50,000 deterministic numeric rows with `Title`, `A`, `B`, and `C`, using
1,000-row batches. No formula field exists in the reusable seed.

## Execute Phase

Create `Total = ({A} * {B}) + {C}` after seed readiness, then poll until the
complete result column is correct.

## Primary Metric

- `formulaFullReadyMs`: formula-create request start until a full paged scan can
  read all 50,000 expected values.

The 30-second initial guardrail is deliberately wide pending runtime history;
seed construction is never included.

## Verification

- First, middle, and last samples must match locally computed values.
- A full 50,000-row scan must match the deterministic expression.
- The field-create routing must match the requested engine.

## Notes

This is the scale companion to `formula/10k-calc`; the formula and row generator
are unchanged.
