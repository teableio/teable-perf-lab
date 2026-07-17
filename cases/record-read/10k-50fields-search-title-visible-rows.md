---
owner: backend-v2
tags:
  [record-read, get-records, search, visible-rows, text, 10k, 50fields, v1-v2]
enabled: true
---

# record-read/10k-50fields-search-title-visible-rows

## Goal

Measure field-scoped grid search when search hides nonmatching rows in a wide
10,000-row read.

## Seed Phase

Reuse the shared record-read fixture with unique padded titles from
`Read row-00001` through `Read row-10000` and 49 additional projected fields.

## Execute Phase

Run the baseline scan, then pass the public search tuple for value `00042`,
field `Title`, and `hideNotMatchRow=true` through the same page sequence.

## Primary Metric

`getRecordsQueryOverheadMs`, the non-negative search-minus-baseline duration.
Initial guardrail: 8,000 ms.

## Notes

Verification requires the one exact matching row, validates all 50 values, and
rejects highlight-only behavior that would leave all rows visible.
