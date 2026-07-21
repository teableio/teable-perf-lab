# Scale-up Batch 09: maximum-width record-duplicate canary

## Selection evidence

Batch 08 changes the existing 500-request record-duplicate matrix from 10 to 100
fields. Its completed local V1 half still reports only 104.44–121.46 ms p95, with
the multiple-select case highest at 121.46 ms. The historical 10-field multiple-
select sibling was 102.87 ms on V1 and 70.27 ms on V2.

The next real scale variable is record width. Teable's product limit is 500 fields
per table, so this batch introduces one maximum-width canary before multiplying
that expensive fixture across the remaining scalar types. Increasing the request
count would not change what the per-request `duplicateSingleP95Ms` metric measures.

## Canary case spec

- **Case**: `record-duplicate/single-500-multiple-select-500fields`.
- **Goal**: measure the public single-record duplicate endpoint when each source
  record contains the maximum supported field count and array-valued cells.
- **Seed Phase**: create 1,000 deterministic rows with `Title` plus 499 multiple-
  select fields. This is 500,000 populated cells and is intentionally the only
  expensive physical-width canary in the batch.
- **Execute Phase**: sequentially duplicate the first 500 source records through
  the same endpoint and request order used by the 10- and 100-field siblings.
- **Primary Metric**: `duplicateSingleP95Ms`, with a 5,000 ms failure ceiling. The
  ceiling is not a duration target.
- **Verification**: verify all 500 copied records across all 500 fields, the final
  1,500-row count, sampled values at offsets 0, 249, and 499, and matched V1/V2
  `duplicateRecord` routing.
- **Controlled variables**: source/duplicate counts, generator, choice set, request
  sequence, timer boundary, and verification remain fixed. Only field width changes.

## Acceptance

- V1 and V2 both pass locally and in GitHub Actions.
- Artifacts report exactly 500 fields, 1,000 source rows, 500 duplicate requests,
  500 fully verified duplicates, and a final count of 1,500.
- CI saves every selected representative trace with zero failures.
- Compare 10-, 100-, and 500-field p95 without using the observed ratio to retune
  the workload.
- Only after this canary establishes feasibility should the 500-field matrix expand
  to other scalar types.
