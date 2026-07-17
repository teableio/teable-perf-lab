---
owner: backend-v2
tags: [field-convert, text, single-select, choices, 10k, v1-v2]
enabled: true
---

# field-convert/10k-text-to-single-select

## Goal

Guard choice discovery and backfill while converting 10,000 text values to a
single-select field.

## Seed Phase

Create `Title` plus `Select Text`; values cycle through `Todo`, `Doing`, and
`Done`.

## Execute Phase

Convert to single select with only `Todo` predefined.

## Primary Metric

- `convertTextToSingleSelectReadyMs` (initial guardrail: 15,000 ms).

## Verification

Require requested-engine routing, target type, all original row values, and the
exact resulting choice-name set `Todo`, `Doing`, `Done`.

## Notes

Repeated values keep option cardinality bounded while exercising choice creation.
