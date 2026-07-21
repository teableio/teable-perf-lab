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

- **Case**: `record-duplicate/single-500-checkbox-500fields`.
- **Goal**: measure the public single-record duplicate endpoint when each source
  record contains the maximum supported field count using a compact stored type.
- **Seed Phase**: create 1,000 deterministic rows with `Title` plus 499 checkbox
  fields. This is 500,000 populated cells and is intentionally the only
  expensive physical-width canary in the batch. Seed writes use 100-row transport
  batches so setup does not collapse all 500,000 cells into one API request; seed
  transport remains outside the primary timer.
- **Execute Phase**: sequentially duplicate the first 500 source records through
  the same endpoint and request order used by the 10- and 100-field siblings.
- **Primary Metric**: `duplicateSingleP95Ms`, with a 5,000 ms failure ceiling. The
  ceiling is not a duration target.
- **Verification**: verify all 500 copied records across all 500 fields, the final
  1,500-row count, sampled values at offsets 0, 249, and 499, and matched V1/V2
  `duplicateRecord` routing.
- **Controlled variables**: source/duplicate counts, generator, choice set, request
  sequence, timer boundary, and verification remain fixed. Field width is the only
  measured-workload variable; seed transport is reduced from 1,000 to 100 rows per
  setup request to keep the fixture build valid at maximum width.

## First local attempt

The first V1/V2 attempt used 499 populated multiple-select fields. Both engines
failed before the measured operation. PostgreSQL reported `row is too big: size
11048/11096, maximum size 8160`; reducing the seed transport from 1,000 to 100
rows reproduced the same physical-row failure. That workload cannot create a
valid source record, so it is not a performance case. The canary now uses 499
checkbox fields at the same supported 500-field table limit, with 100-row seed
transport; the 500 sequential duplicate requests and timer boundary are unchanged.
The first checkbox run then exposed a runner-only HTTP 431: readiness and value
verification serialized all 500 field ids into the GET projection query. These
checks require every table field anyway, so the runner now omits the redundant
projection and relies on the API's all-field default. The same 500 fields are still
compared cell by cell, while the request URL stays bounded. The narrow one-field
projection used only for row-count scans remains unchanged.
The failed run also exposed a framework logging defect: rethrowing an AxiosError
after writing the compact failure artifact lets Vitest serialize its full request
config, including the 500-field seed body. Batch 09 centralizes compact artifact
normalization and rethrows a property-free Error while retaining name, message,
and stack; focused tests cover Error, Axios-like, and non-Error failures.

## Acceptance

- V1 and V2 both pass locally and in GitHub Actions.
- Artifacts report exactly 500 fields, 1,000 source rows, 500 duplicate requests,
  500 fully verified duplicates, and a final count of 1,500.
- CI saves every selected representative trace with zero failures.
- Compare 10-, 100-, and 500-field checkbox p95 without using the observed ratio
  to retune the workload.
- Only after this canary establishes feasibility should maximum-width coverage
  expand to other physically valid stored layouts. Array-valued layouts require
  a separate feasibility probe below the PostgreSQL row-size ceiling.

CI trace selection is intentionally limited to duplicate requests 1, 250, and
500, with any duplicate request available as fallback. Fetching all 500 traces
would test exporter retention rather than preserve representative evidence.

## Local evidence

Artifact directory:
`/tmp/perf-scale-batch09-checkbox-local-retry.20260721`.

| Engine | Result |       p95 | Total for 500 requests | vs 10 fields | vs 100 fields |
| ------ | ------ | --------: | ---------------------: | -----------: | ------------: |
| V1     | pass   | 260.23 ms |          105,270.22 ms |        2.87x |         2.49x |
| V2     | pass   | 180.20 ms |           80,465.43 ms |        2.49x |         2.04x |

Both artifacts report 500 fields, 1,000 ready source rows, 500 sequential
duplicate requests, 500 fully checked duplicates, a final 1,500-row count,
three verified samples, and 500 matched route checks. Local tracing was disabled;
both artifacts report zero failed or missing trace fetches. The 10-field values
come from run `29815167099`; the 100-field values come from Batch 08's completed
local run. The observed ratios are evidence only and do not retune the workload.
