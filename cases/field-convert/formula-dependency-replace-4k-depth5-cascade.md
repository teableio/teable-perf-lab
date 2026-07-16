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

# field-convert/formula-dependency-replace-4k-depth5-cascade

## Goal

Measure replacing one lookup dependency in a populated head formula, forcing a
dependency-edge removal and addition in the same 4,000-order schema update.

## Seed Phase

Create 40 `Users`, 4,000 linked `Orders`, and 400 linked `Purchases`. Orders
carry four lookups and five formula levels; purchases roll up and derive a
formula from the final order value.

The head formula initially depends on looked-up Status, first name, and last
name. Email is already populated and used elsewhere in the chain, but not by
the head formula.

## Execute Phase

1. Confirm seed samples and the original dependency ids.
2. Send one `PUT /api/table/{tableId}/field/{fieldId}/convert` request that
   replaces the head formula's last-name dependency with email.
3. Poll paged reads until all 4,000 orders and 400 purchases expose the updated
   full cascade.

## Primary Metric

- `fullCascadeReadyTotalMs`: field-convert request start until the complete
  order and purchase cascade is readable.

Diagnostics split `mutationRequestMs` from `postResponsePropagationMs`. The
initial guardrail is 180 seconds.

## Verification

- Exactly the last-name lookup dependency id is removed and email is added.
- The converted field id and formula type remain stable.
- All 4,000 orders and 400 purchases expose email in the new head-formula path
  and no longer expose last name there.
- Routing headers match the requested V1 or V2 `convertField` path.

## Notes

The request changes exactly one formula field. Add and remove are kept as
separate cases so this two-sided graph diff remains independently diagnosable.
