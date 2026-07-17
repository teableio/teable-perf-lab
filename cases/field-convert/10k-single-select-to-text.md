---
owner: backend-v2
tags: [field-convert, single-select, text, 10k, v1-v2]
enabled: true
---

# field-convert/10k-single-select-to-text

## Goal

Guard conversion of 10,000 scalar option values to single-line text.

## Seed Phase

Create `Title` plus `Status`; values cycle through `Todo`, `Doing`, and `Done`.

## Execute Phase

After seed validation, convert `Status` through the field-convert endpoint and
wait until samples and the full table expose converted values.

## Primary Metric

- `convertSingleSelectToTextReadyMs`: request plus sample readiness and a full
  10,000-row scan (initial guardrail: 15,000 ms).

## Verification

Routing must match the requested engine, the field type must become
`singleLineText`, and every option name must be preserved as a string.

## Notes

Unlike the existing multiple-select case, this path does not join arrays.
