---
owner: backend-v2
tags:
  - field-duplicate
  - link
  - one-many
  - one-way
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-one-many-one-way-link-field

## Goal

Measure duplicating a populated one-way one-many Link field with 10,000
exclusive junction-table edges.

## Seed Phase

- Creates 10,000 deterministic foreign rows and 10,000 host rows.
- Host row `n` links to foreign row `n`, satisfying one-many foreign-record
  exclusivity while producing exactly 10,000 edges.
- The source is a one-way `oneMany` Link; seed caching reuses the ready table
  pair across V1/V2 executions.

## Execute Phase

1. Verify all host rows and deterministic Link samples.
2. Duplicate `Related` to `Related Copy` through the public field endpoint.
3. Require the requested engine and canary feature `duplicateField`.
4. Verify the copy remains one-way `oneMany`, points to the same foreign table,
   and creates no symmetric field.
5. Full-scan all 10,000 host rows and prove source/copy target ids match.

## Primary Metric

- `duplicateLinkFieldMs`: synchronous field-duplicate request latency. Seed,
  verification, and cleanup are excluded.

## Notes

The initial 180-second guardrail is intentionally uncalibrated and will be
replaced with a CI-derived bound before merge. This relationship exercises the
one-way one-many junction-table value-copy path.
