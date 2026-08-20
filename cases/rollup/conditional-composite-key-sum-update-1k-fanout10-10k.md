---
owner: backend-v2
tags:
  [
    rollup,
    sum,
    conditional,
    composite-key,
    propagation,
    update,
    10k,
    fanout10,
    v1-v2,
  ]
enabled: true
---

# rollup/conditional-composite-key-sum-update-1k-fanout10-10k

## Goal

Measure propagation of a two-key conditional sum when 1,000 source amounts change, the write shape that produced the dead-lettered compute tasks in T6849.

## Seed Phase

Same fixture as `rollup/conditional-composite-key-sum-fanout10-10k`: 10k source rows, 10k host rows, 1,000 groups, fanout 10, and a code column splitting each group into two blocks of five.

## Execute Phase

Create and verify the two-key conditional sum as setup. Then add 1,000,000 to slot 1 of every group in one 1,000-record PATCH and scan all host rows until each holds its recomputed sum.

## Primary Metric

`conditionalQueryPropagationReadyMs`: the bulk amount update request plus the full readiness scan after recomputation.

## Verification

Page through all 10,000 host rows. Slot 1 carries code 1, so the 5,000 host rows on code 1 must each increase by exactly 1,000,000 and the 5,000 on code 2 must be unchanged. A rollup that ignored the code equality would move all 10,000.

## Notes

The propagation sibling on a single key is `rollup/conditional-group-active-sum-update-1k-fanout10-10k`.

The reported failure was on this path rather than on backfill: every edit to the source table queued a compute task that hit `statement_timeout`, and `statement_timeout` is classified non-retryable, so each one dead-lettered on its first attempt.

Like its backfill sibling, this case does not act as a tripwire for `529145a4` — see [conditional-composite-key-sum-fanout10-10k.md](conditional-composite-key-sum-fanout10-10k.md) for the measurements and for why the automatically created match index removes the cost gap. It is registered as coverage of a two-key propagation shape, not as a guard.

## Open Assumptions

- One changed amount per group represents a broad reconciliation update.
- Mutation targeting picks odd slots, and at `codeCount: 2` with 1,000 changed rows that is slot 1 only, so the mutation lands entirely in code 1. The unchanged half is a verification asset, not a gap, but a case that needs both codes mutated would have to raise `mutation.recordCount`.
- The 120-second guardrail copies the single-key propagation sibling and should be tightened once CI history exists; locally the metric sits near 1.1 seconds.
