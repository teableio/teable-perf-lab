# Lookup Search Index Table Spec

## Goal

Cover global search performance on tables with conditional lookup fields. The
comparison variable is table-level `TableIndex.search` on vs off.

This is not a V1/V2 routing test. V1 and V2 bases hold the same table shape and
data so manual runs can compare equivalent environments.

## Search Path

Use global search. The second `search[]` value must stay empty; otherwise the
indexed global-search SQL branch is bypassed.

```text
GET /api/table/{tableId}/aggregation/search-index
  ?skip=0
  &take=100
  &viewId={viewId}
  &search[]=A1-Value-9522
  &search[]=
  &search[]=true
```

This endpoint returns hit navigation metadata:

- `index`: hit order in the search result page
- `fieldId`: field that matched the search term
- `recordId`: record that matched the search term

It does not expose V1/V2 routing. V1 and V2 are represented by separate bases
with equivalent table shapes. The perf-lab implementation splits
`TableIndex.search` off and on into two independent cases.

## Implemented Cases

Runnable cases:

- Case id: `lookup/search-index-off-10k-20search-fields`
- Case id: `lookup/search-index-on-10k-20search-fields`
- Runner: `lookup-search-index`
- Descriptions:
  - `cases/lookup/search-index-off-10k-20search-fields.md`
  - `cases/lookup/search-index-on-10k-20search-fields.md`

The two cases share the same deterministic seed fixture. The runner still
creates both OFF and ON host tables so seed caching can restore equivalent data,
but each case measures only the selected `tableIndexMode`.

## Mixed Dataset

- Source rows: 10,000
- Host rows per host table: 10,000
- Host tables:
  - OFF host: `TableIndex.search` disabled
  - ON host: `TableIndex.search` enabled after lookup fields are ready
- Source fields:
  - `Source Key`: `A-Key-<n>`
  - `Source Text 1..5`: `A<k>-Value-<n>`
  - `Source User 1..2`
- Host fields:
  - `Host Key`: `B-Key-<n>`
  - `Lookup Key 1..5`: permuted source keys
  - `Own Text 1..3`
  - `Own Number 1..2`
  - `Own User 1..2`
  - `Lookup Text 1..5`
  - `Lookup User 1..2`
- Permutation:
  - `sourceRow = (((hostRow - 1) * 73 + 19) % 10000) + 1`

Each lookup key column uses the same base permutation plus a deterministic
per-key offset. `Lookup Text 1..5` and `Lookup User 1..2` are conditional
lookups from the source table.

The runner creates 10 case-owned users/collaborators in seed:
`usrPerfLookupSearch_0` through `usrPerfLookupSearch_9`. They are cached with
the seed database dump and are not added to the global `teable-ee` e2e seed.

## Field Coverage

The mixed host tables intentionally include both native fields and conditional
lookup fields so global search must scan a wider row shape:

| Field Group    | Count | Notes                                      |
| -------------- | ----: | ------------------------------------------ |
| Primary text   |     1 | `Host Key`                                 |
| Lookup keys    |     5 | `Lookup Key 1..5`, values like `A-Key-n`   |
| Own text       |     3 | Native text fields on host table           |
| Own number     |     2 | Native number fields on host table         |
| Own user       |     2 | Native user fields on host table           |
| Lookup text    |     5 | Conditional lookup from source text fields |
| Lookup user    |     2 | Conditional lookup from source users       |
| Total per host |    20 | Search candidate field count               |

Do not rely on `MAX_SEARCH_FIELD_COUNT` changes for this case. The fixture is
itself 20 searchable fields, so it follows the default first-20 global-search
path when that cap is active. Date fields are intentionally excluded because
global search filters out `DateTime` fields.

## Manual Smoke Tables

| Env | Base                  | Role     | Table                 | View                  | User Lookup Fields                                  | Index State |
| --- | --------------------- | -------- | --------------------- | --------------------- | --------------------------------------------------- | ----------- |
| V1  | `bseQNQNg2VVKMftRqYN` | Source   | `tblMLcuTvlW5axAVyzt` | -                     | -                                                   | n/a         |
| V1  | `bseQNQNg2VVKMftRqYN` | Host OFF | `tblnpKur8tCBV2EBJNN` | `viwai0ROTHPz59EFJLq` | `fldOBAs8WVYRDarF3Hu`, `fldsMzhxNrr5YhyvPSM`        | off         |
| V1  | `bseQNQNg2VVKMftRqYN` | Host ON  | `tblYel5OuL5HVam2ITR` | `viwPKXky34fQr8VnIlm` | `fldhP6l6p1UklM1vyE2`, `fldFNoPKd7HcZHxNc7s`        | on          |
| V2  | `bsetXelcuVNtfKf09Mt` | Source   | `tbljFw35GOW6hAlWdIj` | -                     | -                                                   | n/a         |
| V2  | `bsetXelcuVNtfKf09Mt` | Host OFF | `tblgzBGjl6yi7Nh7mMj` | `viwiSp4dz1nLYpBOGat` | fresh: `fldjrYaznntJZ0bZjmj`, `fldFYgycS0BzonJD5fx` | off         |
| V2  | `bsetXelcuVNtfKf09Mt` | Host ON  | `tblP662l9lw4IMl3WJS` | `viwvngpQ0RZxCh3VqEM` | fresh: `fld4CHjrvkuaGblFJlh`, `flddMhP8G8CPAtMUdrV` | on          |

## Keyword Selection

Use more than one keyword shape. They exercise different hit counts and field
groups.

| Keyword         | Expected Hits | Matched Field Shape                | Use Case                       |
| --------------- | ------------: | ---------------------------------- | ------------------------------ |
| `A1-Value-9522` |             1 | `Lookup Text 1` conditional lookup | Sparse lookup-result search    |
| `A-Key-9999`    |             5 | `Lookup Key 1..5` native text      | Sparse host-key search         |
| `A-Key-9876`    |             5 | `Lookup Key 1..5` native text      | Alternate sparse host-key term |
| `A-Key-10000`   |             5 | `Lookup Key 1..5` native text      | Alternate sparse host-key term |
| `A-Key-4520`    |             5 | `Lookup Key 1..5` native text      | Alternate sparse host-key term |
| `A-Key-45`      |         >=100 | `Lookup Key 1..5` native text      | High-hit term, capped by take  |
| user keyword    |   sanity-only | Own user + lookup user fields      | User-field search sanity check |
| `A-Key-452 `    |             0 | No exact value with trailing space | Negative sanity check          |

`A-Key-45` is high-hit because search is substring-like for these text values:
it also matches values such as `A-Key-450` through `A-Key-4599`. Because the
request uses `take=100`, result count caps at 100 and cannot show the full
matching rows. Returned field-hit count may exceed 100 if a selected row matches
more than one field.

For lookup performance smoke, prefer:

- `A1-Value-9522` for a one-hit conditional lookup result.
- `A-Key-9999` for a five-hit low-cardinality host text search.
- `A-Key-45` only when testing high-hit pagination/capped-result behavior.

## Manual Smoke Timings

These historical numbers came from manually created local tables and include
local `teable call-api` CLI overhead. Use them as smoke signals, not final
benchmark numbers for the implemented runner.

### `A1-Value-9522`

One-hit conditional lookup result search. First hit field is `Lookup Text 1` in
each host table.

| Env | Index State | Hit Count | Samples ms                        | P50 ms | P95 ms | Max ms |
| --- | ----------- | --------- | --------------------------------- | ------ | ------ | ------ |
| V1  | off         | 1         | 544.7, 444.7, 437.7, 428.8, 430.7 | 437.7  | 544.7  | 544.7  |
| V1  | on          | 1         | 303.0, 286.4, 365.1, 363.5, 286.3 | 303.0  | 365.1  | 365.1  |
| V2  | off         | 1         | 519.8, 498.7, 491.8, 497.4, 472.4 | 497.4  | 519.8  | 519.8  |
| V2  | on          | 1         | 283.5, 303.1, 302.1, 309.1, 282.4 | 302.1  | 309.1  | 309.1  |

### `A-Key-9999`

Ten-hit native host text search. Hits are in lookup-key fields; this is not a
lookup-result match.

| Env | Index State | Hit Count | Samples ms                        | P50 ms | P95 ms | Max ms |
| --- | ----------- | --------- | --------------------------------- | ------ | ------ | ------ |
| V1  | off         | 10        | 455.1, 435.8, 430.2, 525.5, 425.6 | 435.8  | 525.5  | 525.5  |
| V1  | on          | 10        | 302.5, 286.6, 281.4, 283.4, 300.8 | 286.6  | 302.5  | 302.5  |
| V2  | off         | 10        | 482.2, 459.1, 501.1, 463.9, 464.9 | 464.9  | 501.1  | 501.1  |
| V2  | on          | 10        | 288.8, 286.5, 286.0, 286.4, 291.8 | 286.5  | 291.8  | 291.8  |

### `A-Key-452`

High-hit native host text search. Results cap at `take=100`.

| Env | Index State | Hit Count | Samples ms                        | P50 ms | P95 ms | Max ms |
| --- | ----------- | --------- | --------------------------------- | ------ | ------ | ------ |
| V1  | off         | 100       | 633.1, 515.6, 454.6, 404.7, 406.9 | 454.6  | 633.1  | 633.1  |
| V1  | on          | 100       | 301.5, 302.8, 299.2, 286.9, 293.6 | 299.2  | 302.8  | 302.8  |
| V2  | off         | 100       | 476.7, 468.9, 457.6, 452.8, 437.8 | 457.6  | 476.7  | 476.7  |
| V2  | on          | 100       | 301.6, 286.8, 283.1, 285.0, 292.4 | 286.8  | 301.6  | 301.6  |

### Smoke Interpretation

- `TableIndex.search=on` is consistently faster than off in the smoke runs.
- V1 and V2 are close because the endpoint is shared and the indexed search SQL
  branch is effectively the same path.
- CLI timing includes process startup, auth, HTTP, JSON parsing, and server
  time. Use runner/server-side timing for final benchmark numbers.
- Five samples are only smoke data. Use 30+ samples for a regression gate.

## Simple Dataset

Earlier simple tables cover one text conditional lookup only. Keep them as a
minimal smoke set.

### Simple Tables

| Env | Base                  | Role     | Table                 | View                  | Lookup Field          | Index State |
| --- | --------------------- | -------- | --------------------- | --------------------- | --------------------- | ----------- |
| V1  | `bseQNQNg2VVKMftRqYN` | Source   | `tblke3MrkWyQsgYX6HJ` | -                     | -                     | n/a         |
| V1  | `bseQNQNg2VVKMftRqYN` | Host OFF | `tblDcc1TCuNv0SgSh3T` | `viwngXdOBGO5yuMOXRx` | `fldyfsqbRXA8nw6aMrp` | off         |
| V1  | `bseQNQNg2VVKMftRqYN` | Host ON  | `tblPtAiBN2aRhE9aysz` | `viwKyFW9u9Xlnqzxefq` | `fldeu02KrfYRa2HQS5T` | on          |
| V2  | `bsetXelcuVNtfKf09Mt` | Source   | `tblWb2hwbhSY5cmT0Z9` | -                     | -                     | n/a         |
| V2  | `bsetXelcuVNtfKf09Mt` | Host OFF | `tblsqA6PW2oimy8NK4I` | `viwsqodARqlcwpMTHsl` | `fld9g98ZFN6ZmLfUNiC` | off         |
| V2  | `bsetXelcuVNtfKf09Mt` | Host ON  | `tblTcpJmwKSAU9w8jtd` | `viwXrWVY7s82OWTsB6A` | `fldtVwIaGGorAtRuB2Q` | on          |
