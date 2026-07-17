---
owner: backend-v2
tags: [field-convert, long-text, text, 10k, v1-v2]
enabled: true
---

# field-convert/10k-long-text-to-text

## Goal

Guard multiline long-text normalization while converting 10,000 cells to
single-line text.

## Seed Phase

Create `Title` plus `Description`; every description contains three
deterministic lines.

## Execute Phase

Convert `Description` to single-line text and wait for sample and full-scan
readiness.

## Primary Metric

- `convertLongTextToTextReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert routing and target type, then verify that each newline is normalized to
a space across all rows.

## Notes

The expected behavior follows Teable's upstream V1/V2 conversion parity tests.
