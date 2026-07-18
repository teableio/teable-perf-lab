---
owner: backend-v2
tags:
  - field-duplicate
  - link
  - many-one
  - 10k
  - v1-v2
enabled: true
---

# field-duplicate/10k-duplicate-many-one-link-field

## Goal

Measure duplicating a populated two-way many-one Link field with 10,000 host
foreign-key values.

## Seed Phase

- Creates 10,000 deterministic foreign rows and 10,000 host rows.
- Host row `n` links to foreign row `n`, producing exactly 10,000 FK values.
- The source is a two-way `manyOne` Link. V1 reuses the shared cached pair; V2
  builds the same deterministic pair natively during unmeasured preparation
  because V1 physical-relation metadata is not compatible with V2 FK copy.

## Execute Phase

1. Verify all host rows and deterministic Link samples.
2. Duplicate `Related` to `Related Copy` through the public field endpoint.
3. Require the requested engine and canary feature `duplicateField`.
4. Verify the copy remains `manyOne`, becomes one-way, points to the same
   foreign table, and creates no additional symmetric field.
5. Full-scan all 10,000 host rows and prove source/copy target ids match.

## Primary Metric

- `duplicateLinkFieldMs`: synchronous field-duplicate request latency. Seed,
  verification, and cleanup are excluded.

## Notes

The initial 180-second guardrail is intentionally uncalibrated and will be
replaced with a CI-derived bound before merge. This relationship exercises the
host-table FK value-copy path. V2 results expose the intentional shared-cache
bypass in `details.v2NativeFixture`; fixture construction is excluded from the
primary metric.
