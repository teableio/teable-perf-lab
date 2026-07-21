# Perf Case Scale-Up Batch 04

## Selection

Scale the complete scalar field-create matrix from a populated 10k table to a
populated 50k table. In the historical V2 run, eight of the ten 10k cases are
below 500ms, one is 501ms, and the 20-field width endpoint is 935ms. Keeping the
whole matrix provides one comparable row-count scale curve instead of selecting
field types after seeing their results.

## Cases

- `field-create/50k-create-1-single-line-text-field`
- `field-create/50k-create-10-single-line-text-fields`
- `field-create/50k-create-10-long-text-fields`
- `field-create/50k-create-10-number-fields`
- `field-create/50k-create-10-date-fields`
- `field-create/50k-create-10-checkbox-fields`
- `field-create/50k-create-10-single-select-fields`
- `field-create/50k-create-10-multiple-select-fields`
- `field-create/50k-create-10-rating-fields`
- `field-create/50k-create-20-single-line-text-fields`

## Case Contract

- Goal: measure the same sequential scalar field-create requests as the 10k
  baselines with one workload variable changed: populated records,
  `10,000 -> 50,000`.
- Runner: reuse `field-create`; no runner or framework extension is expected.
- Seed: all ten cases share one deterministic 50,000-row Title-only seed table
  through `seedIdentity: scalar-title-only-50k`.
- Execute: create the same typed field matrix as each 10k baseline. Seed setup
  and post-create verification remain outside the primary metric.
- Primary metric: `createScalarFieldsMs`, with loose initial hang guards of
  30,000ms for one field, 120,000ms for ten fields, and 180,000ms for twenty
  fields.
- Verification: require exact V1/V2 route evidence and field metadata, then
  full-scan all 50,000 rows and prove every created cell remains empty.
- Trace evidence: retain requests 1/middle/last using the existing per-field
  trace policy.
- Cleanup: delete execute-created fields and restore the shared seed to its
  Title-only shape between siblings, including isolated CI jobs.

## Assumptions

- Row count is the only scaled workload variable. Field definitions, request
  order, routing checks, timer boundary, generator, and verification semantics
  remain identical to the 10k cases.
- Stored scalar fields do not require computed backfill readiness. This is a
  workload definition, not an assumption that either engine is insensitive to
  row count; the run will determine the scaling response.
- The initial `maxMs` values are failure guards, not target runtimes. Historical
  CI data from the new 50k cases should replace them with calibrated thresholds.
- The batch contains one physical 50k fixture shared by ten siblings, so it does
  not multiply seed construction into ten expensive canaries.

## Local Acceptance

The corrected local run enabled the runner seed cache and completed all 20
engine/case combinations against `teable-ee/develop` commit `3834e0111` in
645.83 seconds.

| Case shape                 | V1 `createScalarFieldsMs` | V2 `createScalarFieldsMs` |
| -------------------------- | ------------------------: | ------------------------: |
| 1 single-line text field   |                3,151.51ms |                   71.71ms |
| 10 single-line text fields |               20,156.55ms |                  394.59ms |
| 10 long-text fields        |               18,357.10ms |                1,577.21ms |
| 10 number fields           |               19,195.23ms |                  368.14ms |
| 10 date fields             |               17,761.29ms |                  404.06ms |
| 10 checkbox fields         |               19,946.22ms |                  393.65ms |
| 10 single-select fields    |               21,614.92ms |                  391.85ms |
| 10 multiple-select fields  |               21,082.28ms |                  362.47ms |
| 10 rating fields           |               18,578.78ms |                  356.36ms |
| 20 single-line text fields |               37,522.41ms |                  757.37ms |

Every artifact passed its threshold, all per-field route checks, exact field
count/type checks, and a 50,000-record full scan covering 50,000 to 1,000,000
created cells. All 20 results used the same physical table; the first result
built it and the other 19 reported a seed-cache hit. Local trace references
were selected correctly, but trace bodies were not saved because the sandbox
has no trace backend; CI remains the trace-body acceptance surface.
