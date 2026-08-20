---
owner: backend-v2
tags: [rollup, sum, conditional, composite-key, 10k, fanout10, v1-v2]
enabled: true
---

# rollup/conditional-composite-key-sum-fanout10-10k

## Goal

Measure adding a conditional numeric sum whose filter AND-s two field-reference equalities, the "name + code" reconciliation shape reported in T6849.

## Seed Phase

Create a 10k-row source and a 10k-row host with 1,000 groups and fanout 10. A code column on both sides splits every group into two blocks of five slots; host rows alternate between the two codes. Group keys therefore overlap across codes, so only the pair identifies a match.

## Execute Phase

Create a conditional rollup filtered by `A Group is {Lookup Group} AND A Code is {Lookup Code}`, apply `sum({values})`, and scan all 10k host rows for the exact sum of their own five-slot block.

## Primary Metric

`conditionalQueryReadyMs`: field creation plus full readiness scan.

## Verification

Page through all 10,000 host rows and compare each sum against the model. Two host rows on the same group but different codes must hold different sums, which is what a filter that drops the second equality would get wrong.

## Notes

The single-key sibling is `rollup/conditional-group-sum-fanout10-10k`. It aggregates 10 values per host against this case's 5, so the pair is not a controlled A/B on value count; what it does isolate is the number of field-reference equalities, which is what decides the plan.

Before teable-ee `529145a4`, two AND-ed field-reference equalities aborted the
set-based plan for the whole rollup, leaving one correlated aggregate per dirty
host row. Values were correct on both sides of that commit; only the cost
changed.

**This case does not act as a tripwire for that fix.** Measured on this fixture,
teable-ee `3b1bfd0d7` (the commit before the fix) against develop: 892 ms vs
660 ms here, and
indistinguishable (1,324 ms vs 1,394 ms) on a 100k-source variant. The reason is
that creating a conditional field with a field-reference filter now also indexes
the filter's match columns on the foreign table (teable-ee `942dfce2`, T6826,
merged the day before the fix), and this case's own field creation is what
triggers that — a fixture built through the public API cannot
reach the unindexed state the report came from. The same 10k-host / 100k-source
shape in raw SQL: a per-row correlated aggregate over unindexed match columns
runs 3,450 ms, the same shape with those indexes runs 41 ms, and one set-based
group-and-join runs 14 ms. So the fix is worth ~250x on the shape that produced
the report and ~3x once the index exists, and 3x on a few hundred milliseconds
of compute does not surface in a metric that also pages 10,000 records back
through the API.

What the case does carry is coverage: two AND-ed field-reference equalities are a shape no other registered case exercises, and the readiness scan proves the composite key selects the right block on every host row.

## Open Assumptions

- `codeCount: 2` is the smallest split that makes the second equality load-bearing. Wider splits shrink each block and were not measured.
- No `limit`, matching the reported field options.
- The 30-second guardrail copies the single-key sibling and should be tightened once CI history exists; locally the metric sits near 800 ms.
