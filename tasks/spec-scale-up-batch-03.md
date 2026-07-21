# Perf Case Scale-Up Batch 03

## Selection

Complete the typed record-paste scale curve. The existing 1k cases cover nine
stored-field shapes; their historical V2 primary metrics range from about
210ms to 1,260ms, and seven remain below 500ms. The 5k siblings retain the
field matrix so the higher-scale result can be compared by type.

## Cases

- `record-paste/5k-single-line-text-10fields`
- `record-paste/5k-long-text-10fields`
- `record-paste/5k-number-10fields`
- `record-paste/5k-date-10fields`
- `record-paste/5k-checkbox-10fields`
- `record-paste/5k-single-select-10fields`
- `record-paste/5k-multiple-select-10fields`
- `record-paste/5k-rating-10fields`
- `record-paste/5k-mixed-20fields`

## Case Contract

- Goal: measure the same grid paste as each 1k baseline with one workload
  variable changed: records in the single clipboard request, `1,000 -> 5,000`.
- Runner: reuse `record-paste`; no framework extension is expected.
- Seed: no reusable populated table. Execute setup creates the deterministic
  empty typed table and clipboard payload before the timer.
- Execute: V1 uses range paste and V2 uses paste-by-id, matching each baseline.
- Primary metric: `paste5kMs`, with an initial loose `maxMs=30,000` hang guard.
- Verification: require matched V1/V2 routing, scan all 5,000 pasted rows, and
  verify deterministic values at rows 1, 2,500, and 5,000.
- Cleanup: delete the scratch table on a shared local database; isolated CI
  execute databases are discarded whole.

## Assumptions

- Five thousand rows remain inside the existing synchronous paste contract for
  both engines; existing 10k paste cases prove the endpoint supports this row
  scale.
- Field layout, value generator, endpoint choice, routing assertion, timer
  boundary, and verification semantics remain identical to the 1k baselines.
- A populated shared seed is intentionally not reused because pasted records
  are the measured workload. Reusing them would change this into a read case.
- The 100,000-cell runtime allowance covers the widest 5k x 20-field payload;
  it is an environment guard, not an additional workload variable.

## Local Acceptance

Local run against `teable-ee/develop` commit `3834e0111` completed all 18
engine/case combinations.

| Case shape                  | V1 `paste5kMs` | V2 `paste5kMs` |
| --------------------------- | -------------: | -------------: |
| checkbox, 10 fields         |     2,679.46ms |       861.47ms |
| date, 10 fields             |     2,922.87ms |     2,864.63ms |
| long text, 10 fields        |     2,820.03ms |       930.43ms |
| mixed, 20 fields            |     5,169.34ms |     1,722.65ms |
| multiple select, 10 fields  |     4,278.87ms |       894.59ms |
| number, 10 fields           |     2,091.80ms |       939.82ms |
| rating, 10 fields           |     4,070.39ms |       820.57ms |
| single-line text, 10 fields |     2,816.30ms |       962.38ms |
| single select, 10 fields    |     3,262.83ms |       749.98ms |

All artifacts report matched engine routing, 5,000 scanned records, three
verified samples, and one measured-request trace reference. Local trace bodies
were not saved because the sandbox has no trace backend; CI is the trace-body
acceptance environment.

## CI Acceptance

[GitHub Actions run 29838330267](https://github.com/teableio/teable-perf-lab/actions/runs/29838330267)
passed all nine cases on both engines.

| Case shape                  | V1 `paste5kMs` | V2 `paste5kMs` |
| --------------------------- | -------------: | -------------: |
| checkbox, 10 fields         |     6,225.97ms |     1,207.69ms |
| date, 10 fields             |     6,619.95ms |     3,521.66ms |
| long text, 10 fields        |     5,960.21ms |     1,401.92ms |
| mixed, 20 fields            |    11,894.69ms |     2,670.22ms |
| multiple select, 10 fields  |     9,535.87ms |     1,293.06ms |
| number, 10 fields           |     4,102.80ms |       832.08ms |
| rating, 10 fields           |     9,223.51ms |       818.44ms |
| single-line text, 10 fields |     6,194.45ms |     1,267.52ms |
| single select, 10 fields    |     6,932.24ms |     1,055.98ms |

Every artifact reports matched routing, 5,000 scanned records, three verified
samples, one trace reference, one saved trace body, and zero failed trace
fetches. Compared with the historical 1k run on the same CI platform, the
available pairs increased by `3.86x-5.32x` on V1 and `2.09x-3.90x` on V2. The
historical artifact set did not contain the V1 long-text baseline, so no ratio
is claimed for that pair.
