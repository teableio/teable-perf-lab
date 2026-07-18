---
owner: backend-v2
tags:
  - field-duplicate
  - link
  - one-one
  - 10k
  - v2-only
enabled: true
---

# field-duplicate/v2-only-10k-duplicate-one-one-link-field

## Goal

Measure the supported V2 path for duplicating a populated two-way one-one Link
field with 10,000 exclusive host foreign-key values. V1 returns an explicit
skipped artifact because its duplicate path currently attempts to create the
copy with the source field's constraint name and PostgreSQL rejects it with
`42710 duplicate_object`.

## Seed Phase

- Creates 10,000 deterministic foreign rows and 10,000 host rows.
- Host row `n` links to foreign row `n`, satisfying one-one exclusivity while
  producing exactly 10,000 FK values.
- The source is a two-way `oneOne` Link. V2 builds the deterministic table pair
  natively during unmeasured preparation because V1 physical-relation and
  constraint metadata cannot be reused safely by the V2 FK-copy path.

## Execute Phase

1. On V1, return a skipped artifact before fixture preparation and record the
   known duplicate-constraint limitation.
2. On V2, verify all host rows and deterministic Link samples.
3. Duplicate `Related` to `Related Copy` through the public field endpoint.
4. Require V2 routing and canary feature `duplicateField`.
5. Verify the copy remains `oneOne`, becomes one-way, points to the same foreign
   table, and creates no additional symmetric field.
6. Full-scan all 10,000 host rows and prove source/copy target ids match.

## Primary Metric

- `duplicateLinkFieldMs`: synchronous V2 field-duplicate request latency. Seed,
  verification, and cleanup are excluded.

## Notes

The initial 180-second guardrail is intentionally uncalibrated and will be
replaced with a CI-derived bound before merge. This case preserves relationship
matrix coverage without treating the unsupported V1 operation as a performance
success. The result records the intentional shared-cache bypass in
`details.v2NativeFixture`; fixture construction is excluded from the primary
metric.
