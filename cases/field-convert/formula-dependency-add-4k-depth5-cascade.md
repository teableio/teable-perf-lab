---
owner: backend-v2
tags:
  - formula
  - field-convert
  - computed
  - dependency-graph
  - cascade
  - 4k
  - v1-v2
enabled: true
---

# field-convert/formula-dependency-add-4k-depth5-cascade

## Goal

Measure adding one lookup dependency to a populated head formula and rebuilding
the resulting 4,000-order, depth-5 cascade.

## Seed Phase

Create the deterministic computed-chain fixture shared by this case family:

- 40 `Users`, each linked from 100 consecutive `Orders`.
- 4,000 `Orders` with four lookups followed by five formula levels.
- 400 `Purchases`, each linked from 10 consecutive orders, with a rollup and
  dependent formula over the final order formula.

The head formula initially depends on looked-up Status, first name, and last
name. The already-populated email lookup is available but is not a head-formula
dependency.

## Execute Phase

1. Confirm seed samples and the original dependency ids.
2. Send one `PUT /api/table/{tableId}/field/{fieldId}/convert` request that
   changes only the head formula and adds the email lookup dependency.
3. Poll paged reads until all 4,000 orders and 400 purchases expose the updated
   full cascade.

## Primary Metric

- `fullCascadeReadyTotalMs`: field-convert request start until the complete
  order and purchase cascade is readable.

Diagnostics split `mutationRequestMs` from `postResponsePropagationMs`. The
initial guardrail is 180 seconds.

## Verification

- Exactly the email lookup dependency id is added; no dependency is removed.
- The converted field id and formula type remain stable.
- All 4,000 orders and 400 purchases expose the expected updated values.
- All source lookups remain unchanged.
- Routing headers match the requested V1 or V2 `convertField` path.

## Notes

This case changes one formula field. Seed construction is outside the primary
metric, and the schema-mutated local fixture is deleted after execution.
