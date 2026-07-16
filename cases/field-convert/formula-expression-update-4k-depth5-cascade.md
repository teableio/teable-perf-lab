---
owner: backend-v2
tags:
  - formula
  - field-convert
  - computed
  - cascade
  - 4k
  - v1-v2
enabled: true
---

# field-convert/formula-expression-update-4k-depth5-cascade

## Goal

Measure a real one-field schema edit at the head of a long dependency chain.
The formula keeps the same lookup dependencies; only its literal output prefix
changes. This isolates recomputation of an existing graph from dependency-graph
rebuild cases.

## Seed Phase

Create the shared deterministic computed-chain fixture:

- 40 `Users`, each linked from 100 consecutive `Orders`.
- 4,000 `Orders` with four lookups followed by five formula levels.
- 400 `Purchases`, each linked from 10 consecutive orders, with an
  `ARRAY_JOIN` rollup over the final order formula and a formula over that
  rollup.

The first order formula emits `V1:` and depends on the looked-up Status, first
name, and last name. Every later formula depends on the previous formula. Each
case gets an isolated cached instance of this identical fixture so schema and
record mutations cannot leak between cases in a multi-case execute job.

## Execute Phase

1. Confirm seed samples at the first, middle, and last order are fully ready.
2. Send one `PUT /api/table/{tableId}/field/{fieldId}/convert` request that
   changes only the first formula expression from the `V1:` prefix to `V2:`.
3. Poll paged reads until all 4,000 orders expose the new five-level chain and
   all 400 purchases expose rollups/formulas derived from it.
4. A reusable local fixture is deleted after the schema mutation; isolated CI
   execute databases are discarded.

## Primary Metric

- `fullCascadeReadyTotalMs`: field-convert request start until the complete
  4,000-order and 400-purchase cascade is readable.

Diagnostics split the window into `mutationRequestMs` and
`postResponsePropagationMs`. The initial guardrail is 180 seconds.

## Verification

- The converted field id, type, and dependency references remain stable.
- All four lookup controls remain unchanged.
- Every order formula level contains the `V2:` value.
- Every purchase rollup contains all ten expected final order values, and its
  dependent formula exposes the same values.
- Routing headers must match V1 or V2 `convertField` as requested.

## Notes

Adding, replacing, or removing a lookup dependency changes the dependency
graph and is tracked separately in `tasks/todo.md`.
