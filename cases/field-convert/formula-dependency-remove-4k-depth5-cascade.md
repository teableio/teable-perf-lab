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

# field-convert/formula-dependency-remove-4k-depth5-cascade

## Goal

Measure removing one lookup dependency from a populated head formula and
rebuilding the resulting 4,000-order, depth-5 cascade.

## Seed Phase

Create 40 `Users`, 4,000 linked `Orders`, and 400 linked `Purchases`. Orders
carry four lookups and five formula levels; purchases roll up and derive a
formula from the final order value.

The head formula initially depends on looked-up Status, first name, and last
name.

## Execute Phase

1. Confirm seed samples and the original dependency ids.
2. Send one `PUT /api/table/{tableId}/field/{fieldId}/convert` request that
   removes the head formula's last-name dependency.
3. Poll paged reads until all 4,000 orders and 400 purchases expose the updated
   full cascade.

## Primary Metric

- `fullCascadeReadyTotalMs`: field-convert request start until the complete
  order and purchase cascade is readable.

Diagnostics split `mutationRequestMs` from `postResponsePropagationMs`. The
initial guardrail is 180 seconds.

## Verification

- Exactly the last-name lookup dependency id is removed; no dependency is
  added.
- The converted field id and formula type remain stable.
- All 4,000 orders and 400 purchases expose the expected chain without the
  removed last-name value.
- Routing headers match the requested V1 or V2 `convertField` path.

## Notes

The exact dependency-id diff is the graph-removal proof. This case does not add
a second source-cell mutation to the measured operation.
