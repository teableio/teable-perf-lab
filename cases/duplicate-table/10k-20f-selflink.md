---
owner: perf-lab
tags:
  - duplicate-table
  - self-link
  - records
enabled: true
---

# duplicate-table/10k-20f-selflink

## Goal

Measure duplicating a 10,000-record mixed 20-field table that includes a
self manyMany link with records. Exercises the V2 physical bulk path for
self-link tables (T6156 follow-up).

## Seed

1. Create the mixed 20-field table and insert 10k rows (same shape as
   `duplicate-table/10k-20f`).
2. Create a two-way self manyMany link field `Related`.
3. Link each row `i` to row `i+1` (last wraps to first).

## Execute

`POST /duplicate` with `includeRecords: true`, then full-scan verify base
field values. V2 must copy the self-link field and all configured link values.
The legacy V1 comparator does not create the one-way self-link field; the
artifact records that boundary as `legacy-v1-field-absent` instead of implying
that both engines copied the same schema.

## Primary metric

- `duplicateTableRequestMs`
