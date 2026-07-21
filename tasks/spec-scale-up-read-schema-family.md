# Scale-Up Spec: Read and Schema Families

## Scope

Add high-scale siblings for the frozen campaign's scalar field-delete,
record-read, search-index, table lifecycle, duplicate-view, field-create, and
authenticated-user cases.

## Scale Dimensions

- Scalar field delete: populated rows `10k -> 50k`.
- Record-read query variants: shared deterministic rows `10k -> 50k`.
- Search index: rows `50k -> 100k`.
- Table restore/delete: rows `10k -> 50k`.
- Duplicate view: fields `20 -> 500`, the current product-width boundary.
- Single-select field create: ten sequential fields, each with 1,000 options;
  the per-field option count remains at the V2 product limit.
- Authenticated user lookup: one request -> 100 sequential requests.

## Fixture Reuse

Read variants use the runner's existing shared 50k fixture. Search index-off
and index-on use isolated compatible fixtures because index state is part of
the schema. Destructive schema/table cases use a deterministic largest fixture
but do not attempt unsafe in-place reuse after the measured delete.

## Verification

Preserve each baseline's endpoint, timer boundary, primary metric, routing
assertion, and final-state checks. Run source checks and local V1/V2 execution;
inspect each artifact for promised scale, routing, verification, primary
metric, and trace manifest counts.

## Local Acceptance: Record Read

The nine record-read siblings passed local V1/V2 execution against the shared
50k-row, 50-field fixture. The first V1 case built the fixture once
(`seedBuildMs=347986.15`); the other 17 engine/case executions restored it from
cache (`seedCacheHit=1`, restore range 6.2-14.6s). Every case issued 50 paged
requests, matched its expected route, and verified the promised result count.

| Query variant                   | V1 primary ms | V2 primary ms | Returned rows |
| ------------------------------- | ------------: | ------------: | ------------: |
| group number                    |     19,215.89 |          0.00 |        50,000 |
| sort text                       |      7,887.60 |      2,446.30 |        50,000 |
| sort three fields               |      8,258.32 |      4,373.94 |        50,000 |
| filter text not empty           |         99.24 |        667.09 |        50,000 |
| search visible title            |          0.00 |      4,969.44 |             1 |
| filter number and sort          |      9,923.84 |      4,468.45 |        25,000 |
| filter number middle range      |          0.00 |      2,491.49 |        25,000 |
| filter number greater than half |          0.00 |      2,932.41 |        25,000 |
| filter, sort, and group         |     34,816.99 |      4,312.82 |        25,000 |

The selective filter/sort/group V1 query consistently took about 34.7s, so its
hang-guard threshold was raised from 30s to 60s and the case was rerun. This is
not a target-duration adjustment: the measured primary value remains unchanged
and is recorded above. Local trace capture produced request trace references;
snapshot downloads were unavailable because the local Jaeger endpoint was not
running.

## Local Acceptance: Scalar Field Delete

All eight 50k-row scalar field-delete siblings passed local V1/V2 execution.
Each artifact verified all 50,000 surviving records, exactly one deleted field,
one remaining `Title` field, and the expected engine/feature route.

| Deleted field | V1 delete ms | V2 delete ms |
| ------------- | -----------: | -----------: |
| Start Date    |       541.15 |       541.53 |
| Description   |       346.24 |       421.53 |
| Status        |       324.16 |       380.09 |
| Owner         |       317.39 |       378.80 |
| Active        |       332.27 |       361.14 |
| Tags          |       363.50 |       393.53 |
| Amount        |       331.37 |       423.03 |
| Score         |       315.45 |       400.77 |

These fixtures intentionally remain separate. Each baseline schema contains
only `Title` plus the target field, and the target types differ; merging them
into one 20-field seed would change field count as well as row count. Local
trace references were recorded, while snapshot downloads failed because the
local Jaeger endpoint was unavailable.

## Local Acceptance: Schema and API Boundaries

The four independent schema/API siblings passed local V1/V2 execution:

| Case boundary                        | V1 primary ms | V2 primary ms |
| ------------------------------------ | ------------: | ------------: |
| 100 authenticated user requests, p95 |          8.89 |          6.50 |
| 10 fields with 1,000 options, total  |      1,402.21 |      1,315.99 |
| duplicate a 500-field view, p95      |        111.64 |         45.75 |
| duplicate table with 2,000 selflinks |        447.70 |        293.55 |

The self-link run exposed a pre-existing engine boundary that the old runner
did not verify. V1 copies the 20 stored fields but omits the one-way self-link
field; its artifact now records `legacy-v1-field-absent`. V2 copied the field and
verified exactly 2,000 populated links across the 10,000-row full scan. Cleanup
also deletes the copied self-link field before dropping the V2 table, preventing
the former self-reference cleanup failure. Local trace references were present;
snapshot downloads remained unavailable without Jaeger.

## Local Acceptance: Table Lifecycle

All three 50k-row table lifecycle siblings passed local V1/V2 execution. Each
case ran ten samples, matched the expected engine/feature route, and scanned all
50,000 rows before measuring. Restore verified the full row count and sample
text values; the linked variant also verified permuted target titles. Delete
verified the table and trash states, then restored and fully scanned every
sample during cleanup.

| Operation                  | V1 primary ms | V2 primary ms |
| -------------------------- | ------------: | ------------: |
| restore 50k rows + 1k link |         35.91 |         31.62 |
| restore 50k rows           |        105.48 |         26.78 |
| delete 50k-row table       |         31.88 |         32.16 |

The linked and unlinked fixtures retain separate seed hashes because their
schemas differ. Within each compatible fixture, later executions reported
`seedCacheHit=true`; no second seed was manufactured merely to target a runtime
range. The primary operations remain fast at this scale, which is a measured
result rather than a reason to change the timer boundary. Local trace references
were captured; snapshot downloads remained unavailable without Jaeger.

## Local Acceptance: Search Index

Both 100k-row, 20-search-field siblings passed local V1/V2 execution:

| Index mode | V1 p95 ms | V2 p95 ms |
| ---------- | --------: | --------: |
| off        |     78.43 |     66.14 |
| on         |     72.63 |     65.91 |

The first run exposed that the 50k probe `A1-Value-9522` ceases to be unique at
100k because prefix matching also finds rows 95,220-95,229. The scale-up cases
now probe row 99,999, preserving the baseline's selectivity: the three exact
probes verified hit counts `1`, `2`, and `1` on every engine/index combination.

Search index off/on use the same fixture containing source, off-host, and
on-host tables. The shared seed identity now excludes execute-only keywords and
verification sample rows. Its stable hash `3c789709293fbf88` was built once;
the other three executions reported a cache hit. All artifacts verified 100,000
rows and 20 search fields. They captured 270 trace references each; local trace
downloads remained unavailable because the OTEL/Jaeger endpoint was absent.
