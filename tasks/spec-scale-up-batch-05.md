# Scale-up Batch 05: populated scalar field duplication at 50k rows

## Selection evidence

The latest successful full CI history available for the campaign is run
`29815167099`. Its eight populated scalar field-duplicate cases all have V2
primary metrics below the 500 ms review boundary:

| Existing case                                     |         V1 |        V2 |
| ------------------------------------------------- | ---------: | --------: |
| `field-duplicate/10k-duplicate-owner-text-field`  | 2484.77 ms | 180.66 ms |
| `field-duplicate/10k-duplicate-description-field` | 2880.56 ms | 184.86 ms |
| `field-duplicate/10k-duplicate-amount-field`      | 2720.49 ms | 181.59 ms |
| `field-duplicate/10k-duplicate-start-date-field`  | 2314.30 ms | 196.90 ms |
| `field-duplicate/10k-duplicate-active-field`      | 1981.80 ms | 183.61 ms |
| `field-duplicate/10k-duplicate-status-field`      | 2521.99 ms | 172.14 ms |
| `field-duplicate/10k-duplicate-tags-field`        | 2435.47 ms | 238.21 ms |
| `field-duplicate/10k-duplicate-score-field`       | 2524.53 ms | 183.43 ms |

## Scale variable

Increase populated row count from `10,000` to `50,000` while keeping the
measured operation to one public duplicate-field request. Do not tune row count
to a target duration and do not assume either engine is sensitive or
insensitive to this variable; the resulting V1/V2 measurements decide that.

All eight siblings use one physical 50k seed table containing primary `Title`
plus the eight scalar source fields. Each execute case duplicates only its
selected source field, verifies the copied type and all 50,000 copied values,
then deletes only the copied field. This keeps the scale variable deterministic
and avoids rebuilding eight equivalent large fixtures.

## Cases

1. `field-duplicate/50k-duplicate-owner-text-field`
2. `field-duplicate/50k-duplicate-description-field`
3. `field-duplicate/50k-duplicate-amount-field`
4. `field-duplicate/50k-duplicate-start-date-field`
5. `field-duplicate/50k-duplicate-active-field`
6. `field-duplicate/50k-duplicate-status-field`
7. `field-duplicate/50k-duplicate-tags-field`
8. `field-duplicate/50k-duplicate-score-field`

## Acceptance contract

- Both V1 and V2 produce a passing result for every case.
- The primary metric is `duplicateScalarFieldMs`; seed construction, the seed
  readiness scan, copied-value verification, and cleanup remain outside it.
- All eight cases resolve to one seed hash/table per engine, with one seed build
  and subsequent cache hits.
- Every result reports exactly 50,000 seeded and verified records, the expected
  source/copy field names and types, and a matched `duplicateField` route.
- CI trace manifests save every selected trace reference with zero failures.
- Compare CI results with run `29815167099` to report the observed 10k-to-50k
  ratio without using that ratio to change the workload.

## Guardrails

- `maxMs: 40,000` is a failure ceiling, not a duration target. It gives the
  historical slowest V1 result room for a roughly five-times row increase plus
  CI variance.
- `timeoutMs: 900,000` and `watchdogMs: 300,000` retain the existing family
  limits because full scans and fixture work are not primary metrics.
- Keep the operation lifecycle unchanged: it already removes only the copied
  field when a reusable seed is active. Limit the runner extension to the same
  explicit shared `seedIdentity` mapping already used by field-create and
  record-create so sibling case ids do not fragment the cache.

## Validation plan

1. Run catalog, type, case, README, and full repository checks.
2. Refresh/inject the local `teable-ee` sandbox and execute all eight cases on
   V1 and V2 with seed cache enabled.
3. Audit local result JSON for thresholds, shared seed reuse, 50k full scans,
   routing, and copied values.
4. Run only these eight cases in GitHub Actions for V1/V2 and audit downloaded
   lightweight/full artifacts plus trace manifests.

## Local acceptance

The first runtime attempt exposed that the generic cache hash still included
each sibling `caseId`; seven passing V1 cases therefore built seven different
50k tables. That attempt was stopped before the eighth case completed. The
runner now maps an explicit stored-field `seedIdentity` to a shared synthetic
case id, with a focused contract test preventing regression.

After reinjection, the corrected run completed all 16 V1/V2 combinations on
`teable-ee/develop` commit `3834e0111` in 336.37 seconds:

| Source field | V1 `duplicateScalarFieldMs` | V2 `duplicateScalarFieldMs` |
| ------------ | --------------------------: | --------------------------: |
| Owner Text   |                 8,894.64 ms |                   691.98 ms |
| Description  |                 8,631.09 ms |                   711.25 ms |
| Amount       |                 9,335.73 ms |                 1,660.51 ms |
| Start Date   |                10,696.26 ms |                   615.36 ms |
| Active       |                 8,037.54 ms |                   660.50 ms |
| Status       |                 7,686.66 ms |                   663.82 ms |
| Tags         |                 7,037.75 ms |                   649.19 ms |
| Score        |                 8,008.59 ms |                   681.95 ms |

All thresholds and `duplicateField` route assertions passed. Every result
reported the same table id and seed hash, 50,000 seeded and readiness-scanned
records, a 50,000-row source/copy full scan, and equal source/copy types. The
first result was the only cache miss; the remaining 15 were hits. Local trace
collection was disabled because the sandbox has no trace backend; CI remains
the trace-body acceptance surface.
