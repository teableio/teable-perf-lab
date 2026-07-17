---
owner: backend-v2
tags:
  - table-delete
  - linked-records
  - detach-link
  - 30k
  - v1-v2
enabled: true
---

# table-delete/30k-20f-link-detach

## Goal

Measure deleting a referenced table while 30,000 surviving host rows still hold
link cells, amplifying the known row-dependent V1 `detachLink` work while
preserving the V2 soft-delete comparison.

## Seed Phase

Create a deterministic 30,000-row mixed host table, a 1,000-row foreign table,
and one populated link field whose targets follow the existing permutation.

## Execute Phase

Archive the foreign table once. V1 performs destructive link detachment on the
surviving host; V2 keeps its soft-delete behavior. The sample measures only the
delete request.

## Primary Metric

- `deleteTableDetachLink30kMs`: the single 30k archive request. The paired 10k
  case retains three-sample p95 coverage; using one fixture here avoids seeding
  90k linked host rows merely to repeat an already-established request shape.

The initial 30-second guardrail is derived conservatively from the existing 10k
case and will be tightened after runtime history.

## Verification

- The target table must enter trash after the sample.
- The surviving host table must retain all 30,000 records.
- Link-field behavior and routing must match the existing engine-specific
  contract.

## Notes

Only host-row scale changes from the 10k sibling; the foreign-table size and
link permutation remain fixed. The 30k case intentionally uses one sample after
a three-fixture cold CI seed exceeded its 30-minute case budget.
