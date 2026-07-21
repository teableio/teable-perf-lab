# Perf Case Scale-Up Batch 02

## Selection

Complete the missing typed members of the existing 1k -> 5k record create and
record update curves. The previous full CI run showed these baselines around
318-490ms on the slower engine for date, long-text, single-select, and
multiple-select workloads; single-line text is included to complete the same
field matrix even though V1 was slightly above 500ms in that run.

## Cases

### Record create

- `record-create/5k-single-line-text-fields-bulk-create`
- `record-create/5k-long-text-fields-bulk-create`
- `record-create/5k-date-fields-bulk-create`
- `record-create/5k-single-select-fields-bulk-create`

### Record update

- `record-update/5k-single-line-text-fields-bulk-update`
- `record-update/5k-long-text-fields-bulk-update`
- `record-update/5k-date-fields-bulk-update`
- `record-update/5k-single-select-fields-bulk-update`
- `record-update/5k-multiple-select-fields-bulk-update`

## Case Contract

- Goal: measure the same typed bulk operation as each 1k baseline with one
  workload variable changed: records in the measured request, `1,000 -> 5,000`.
- Runner: reuse `record-create` or `record-update`; no framework extension is
  expected.
- Seed: create cases reuse the compatible empty `mixed-5k-20fields` fixture;
  update cases reuse the compatible populated `mixed-5k-20fields` fixture.
- Execute: send one 5,000-record create or PATCH request after the fixture and
  deterministic payload are ready.
- Primary metric: `bulkCreate5kMs` or `bulkUpdate5kMs`, with an initial loose
  `maxMs=30,000` hang guard.
- Verification: require 5,000 response ids, matched V1/V2 routing, and
  deterministic samples at rows 1, 2,500, and 5,000. Create also verifies the
  SQL row count and omitted cells; update verifies omitted cells retain seed
  values.
- Cleanup: restore the shared mutable fixture between sibling cases, including
  isolated execute jobs, so every case starts from the same seed-ready state.

## Assumptions

- Five thousand records remain inside the existing comparable bulk endpoint
  contract for both engines.
- Field projection, field count, endpoint, routing assertion, timer boundary,
  and verification semantics remain identical to each 1k baseline.
- This batch contains no large seed canary; all nine cases belong to the two
  existing shared 5k write fixtures.

## Local Acceptance

Validated against `teable-ee` develop `aef9bccfd` with both engines. All 18
results passed, all routes matched the requested engine, every response
reported 5,000 affected records, and all three deterministic samples passed.

| Case                    | V1 primary | V2 primary |
| ----------------------- | ---------: | ---------: |
| create date             |    1,140ms |    1,569ms |
| create long text        |    1,847ms |    1,498ms |
| create single-line text |    2,220ms |    2,899ms |
| create single select    |    2,308ms |    1,730ms |
| update date             |    1,329ms |    1,510ms |
| update long text        |    1,609ms |    1,305ms |
| update multiple select  |    1,203ms |    1,346ms |
| update single-line text |    2,129ms |    1,415ms |
| update single select    |    1,474ms |    1,179ms |

Each result captured one trace reference. Local trace snapshot fetches were
expectedly unavailable because no Jaeger or trace-link endpoint was configured;
CI remains the trace-artifact acceptance environment.

## CI Acceptance

[Workflow run 29827505760](https://github.com/teableio/teable-perf-lab/actions/runs/29827505760)
passed on both engines. All 18 result artifacts passed routing and deterministic
sample verification, reported 5,000 affected records, and saved their measured
trace without a fetch failure.

| Case                    | V1 primary | V2 primary |
| ----------------------- | ---------: | ---------: |
| create date             |    1,659ms |    2,128ms |
| create long text        |    2,514ms |    2,430ms |
| create single-line text |    3,647ms |    2,980ms |
| create single select    |    2,556ms |    2,006ms |
| update date             |    2,375ms |    2,328ms |
| update long text        |    2,469ms |    2,431ms |
| update multiple select  |    2,485ms |    1,426ms |
| update single-line text |    3,081ms |    2,786ms |
| update single select    |    2,425ms |    1,775ms |
