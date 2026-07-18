---
owner: backend-v2
tags:
  - field-duplicate
  - link
  - many-many
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-many-many-link-field

## Goal

Measure duplicating a populated two-way many-many Link field with 10,000
junction-table edges.

## Seed Phase

- Creates 10,000 deterministic foreign rows and 10,000 host rows.
- Host row `n` links to foreign row `n`, producing exactly 10,000 edges.
- The source is a two-way `manyMany` Link; seed caching reuses the ready table
  pair across V1/V2 executions.

## Execute Phase

1. Verify all host rows and deterministic Link samples.
2. Duplicate `Related` to `Related Copy` through the public field endpoint.
3. Require the requested engine and canary feature `duplicateField`.
4. Verify the copy remains `manyMany`, becomes one-way, points to the same
   foreign table, and creates no additional symmetric field.
5. Full-scan all 10,000 host rows and prove source/copy target ids match.

## Primary Metric

- `duplicateLinkFieldMs`: synchronous field-duplicate request latency. Seed,
  verification, and cleanup are excluded.

## Notes

The 100-second guardrail was calibrated from official CI runs `29649057939` and
`29650023288`: V1 measured 46,523.25 ms and 35,474.79 ms, while V2 measured
753.04 ms and 787.40 ms. The bound leaves about 2.15x headroom over the observed
worst and protects the junction-table value-copy path.
