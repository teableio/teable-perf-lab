---
owner: backend-v2
tags:
  - record-read
  - get-records
  - read-path
  - lookup
  - formula
  - 10k
  - 50fields
  - v1-v2
enabled: true
---

# record-read/10k-50fields-10x1k-pages

## Goal

Measure `GET /api/table/{tableId}/record` latency for reading a full 10,000-row
table as ten sequential maximum-size 1,000-record pages with 50 projected
fields, including stored lookup columns and formula values.

## Seed Phase

- Creates one source table with 10,000 rows and 21 text fields:
  - `Source Key`: `Read-Key-<n>`
  - `Source Value 1` through `Source Value 20`: deterministic lookup payloads.
- Creates one host table with 10,000 rows and 25 base fields:
  - `Title`
  - `Lookup Source Key`
  - numeric fields `A`, `B`, and `C`
  - text fields `Text 1` through `Text 20`
- The host table maps each row to a unique source row through a deterministic
  permutation using multiplier `73` and offset `19`.
- Adds five formula fields to the host table:
  - `Formula 1`: `{A} + {B} + {C}`
  - `Formula 2`: `({A} * {C}) + {B}`
  - `Formula 3`: `{A} + ({B} * {C})`
  - `Formula 4`: `({A} * 3) + ({B} * 5) + ({C} * 7)`
  - `Formula 5`: `({A} * {B}) + {C}`
- Adds 20 conditional lookup fields that each read a different source value
  through `Lookup Source Key`.
- Waits until a paged full scan can read all 10,000 host rows and verify every
  projected base, formula, and lookup value.

With seed caching enabled, the source and host tables are named from the
runner `seedHash` and reused across engines and workflow runs. A restored seed
must pass the same full projection scan before execute.

## Execute Phase

1. Restore or build the 10k-row source and host seed tables.
2. Verify the 50-field projection is readable across all 10,000 rows.
3. Start the primary timer.
4. Inside one measurement window, call `GET /api/table/{tableId}/record`
   sequentially ten times with:
   - `fieldKeyType: "id"`
   - `viewId`
   - `projection`: the 50 host fields
   - `skip`: `0`, `1000`, `2000`, through `9000`
   - `take: 1000`
5. Stop the primary timer when the 10th response is received.
6. Verify the measured pages contain 10,000 total records, each with 50
   projected fields, and sample rows across the scan have the expected base,
   formula, and lookup values.

## Primary Metric

- `getRecords10kPagedScanMs`: elapsed time from starting the first external
  `GET /record` request through completion of the 10th response.

Seed creation, formula and lookup readiness, full seed validation, and
post-response page verification are reported as diagnostics such as
`seedBuildMs`, `computedReadyMs`, `seedReadyMs`, and `verifyReadPagesMs`; they
are not included in the primary metric.

## Verification

- The seed full scan must read 10,000 rows and 50 projected fields.
- Every measured response must use the expected V1 or V2 route, based on
  `x-teable-v2`.
- The measured responses must return 10,000 total records across ten pages.
- Each returned record must contain exactly 50 fields.
- Rows 1, 500, 1,000, 5,000, and 10,000 of the measured scan are verified against
  deterministic base, formula, and lookup values.

## Notes

This is a read-path regression case for the `getRecords` canary feature. The
page size is intentionally 1,000 because the OpenAPI schema caps `take` at 1,000
records. The 50-field projection includes 20 lookup fields to cover the stored
lookup-column read-query path.

Cleanup uses the B-class strategy: execute only reads the reusable seed fixture,
so local cleanup keeps the cached source and host tables. On the next cache hit,
the runner revalidates the 10,000-row, 50-field projection before measuring.
