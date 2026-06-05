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

- Case id: `search/search-index-off-10k-20search-fields`
- Case id: `search/search-index-on-10k-20search-fields`
- Runner: `lookup-search-index`
- Descriptions:
  - `cases/search/search-index-off-10k-20search-fields.md`
  - `cases/search/search-index-on-10k-20search-fields.md`

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
  - `Source Text 1`: `A1-Value-<n>`
  - `Source Number 1`
  - `Source Date 1`
  - `Source Status`
  - `Source Tags`
  - `Source User 1..2`
- Host fields:
  - `Host Key`: `B-Key-<n>`
  - `Lookup Key 1..2`: permuted source keys
  - `Own Text 1..3`
  - `Own Number 1..2`
  - `Own Date 1`
  - `Own Status`
  - `Own Tags`
  - `Own User 1..2`
  - `Lookup Text 1`
  - `Lookup Number 1`
  - `Lookup Status`
  - `Lookup Tags`
  - `Lookup Date 1`
  - `Lookup User 1..2`
- Permutation:
  - `sourceRow = (((hostRow - 1) * 73 + 19) % 10000) + 1`

Each lookup key column uses the same base permutation plus a deterministic
per-key offset. Lookup fields are conditional lookups from the source table.

The runner creates 10 case-owned users/collaborators in seed:
`usrPerfLookupSearch_0` through `usrPerfLookupSearch_9`. They are cached with
the seed database dump and are not added to the global `teable-ee` e2e seed.

## Field Coverage

The mixed host tables intentionally include both native fields and conditional
lookup fields so global search must scan a wider row shape:

| Field Group            | Count | Notes                                                |
| ---------------------- | ----: | ---------------------------------------------------- |
| Primary text           |     1 | `Host Key`                                           |
| Lookup keys            |     2 | `Lookup Key 1..2`, values like `A-Key-n`             |
| Own text               |     3 | Native text fields on host table                     |
| Own number             |     2 | Native number fields on host table                   |
| Own date               |     1 | Native date field; included in layout, not a keyword |
| Own select             |     1 | Native single-select field on host table             |
| Own multiple-select    |     1 | Native multiple-select field on host table           |
| Own user               |     2 | Native user fields on host table                     |
| Lookup text            |     1 | Conditional lookup from source text                  |
| Lookup number          |     1 | Conditional lookup from source number                |
| Lookup date            |     1 | Conditional lookup from source date; not a keyword   |
| Lookup select          |     1 | Conditional lookup from source single-select         |
| Lookup multiple-select |     1 | Conditional lookup from source multiple-select       |
| Lookup user            |     2 | Conditional lookup from source users                 |
| Total per host         |    20 | Field count kept at the global-search default cap    |

Do not rely on `MAX_SEARCH_FIELD_COUNT` changes for this case. The fixture is
itself 20 searchable fields, so it follows the default first-20 global-search
path when that cap is active. Date fields are intentionally present to keep the
field layout realistic, but date values are not selected as keywords because
global search does not match `DateTime` values.

## Manual Smoke Tables

| Env | Base                  | Role     | Table                 | Index State |
| --- | --------------------- | -------- | --------------------- | ----------- |
| V1  | `bseQNQNg2VVKMftRqYN` | Source   | `tblmv9dZiJcQYUAEiiN` | n/a         |
| V1  | `bseQNQNg2VVKMftRqYN` | Host OFF | `tblKRjGAy2ZgpDOOjwV` | off         |
| V1  | `bseQNQNg2VVKMftRqYN` | Host ON  | `tblUtPBfDhhZHDyJD8A` | on          |

## Keyword Selection

Use more than one keyword shape. They exercise different hit counts and field
groups.

| Keyword                | Expected Hits | Matched Field Shape                  | Use Case                      |
| ---------------------- | ------------: | ------------------------------------ | ----------------------------- |
| `A1-Value-9522`        |             1 | `Lookup Text 1` conditional lookup   | Sparse lookup-result search   |
| `A-Key-9999`           |             2 | `Lookup Key 1..2` native text        | Sparse host-key search        |
| `HostText1-Value-9522` |             1 | `Own Text 1` native text             | Sparse native text search     |
| `Todo`                 |         >=100 | `Own Status` native single-select    | Capped native select search   |
| `Alpha`                |         >=100 | `Lookup Status` lookup single-select | Capped lookup select search   |
| `North`                |         >=100 | `Own Tags` native multiple-select    | Capped native multi search    |
| `Red`                  |         >=100 | `Lookup Tags` lookup multiple-select | Capped lookup multi search    |
| `perf_lookup_user_0`   |         >=100 | Own user + lookup user fields        | Capped user-field search      |
| `A-Key-45`             |         >=100 | `Lookup Key 1..2` native text        | High-hit term, capped by take |

`A-Key-45` is high-hit because search is substring-like for these text values:
it also matches values such as `A-Key-450` through `A-Key-4599`. Because the
request uses `take=100`, result count caps at 100 and cannot show the full
matching rows. Returned field-hit count may exceed 100 if a selected row matches
more than one field.

For lookup performance smoke, prefer:

- `A1-Value-9522` for a one-hit conditional lookup result.
- `A-Key-9999` for a two-hit low-cardinality host text search.
- `HostText1-Value-9522` for a one-hit native host text search.
- `Todo`, `Alpha`, `North`, `Red`, and `perf_lookup_user_0` for capped field
  group coverage.
- `A-Key-45` only when testing high-hit pagination/capped-result behavior.

## Manual Smoke Timings

These historical numbers came from an earlier manually created local table
shape and include local `teable call-api` CLI overhead. Use them as old smoke
signals only, not final benchmark numbers for the implemented runner or the
current 20-field fixture.

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

Historical ten-hit native host text search from the earlier fixture. Hits are in
lookup-key fields; this is not a lookup-result match.

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
