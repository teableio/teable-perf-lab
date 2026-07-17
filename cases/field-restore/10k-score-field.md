---
owner: backend-v2
tags: [field-restore, rating, trash, 10k, v1-v2]
enabled: true
---

# field-restore/10k-score-field

## Goal

Measure restoring a populated rating field and 10,000 bounded score values.

## Seed Phase

Create `Title` plus a five-star `Score` field; scores cycle deterministically
from 1 through 5.

## Execute Phase

Delete `Score`, then measure V1 direct restore or the V2 restore stream.

## Primary Metric

- `restoreFieldMs` (initial guardrail: 120,000 ms).

## Verification

Assert routes, restored field id/name/type, and every generated score in a full
scan.

## Notes

Rating options and bounded-value validation distinguish this from a plain number
field.
