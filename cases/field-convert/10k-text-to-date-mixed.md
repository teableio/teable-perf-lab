---
owner: backend-v2
tags: [field-convert, text, date, utc, 10k, v1-v2]
enabled: true
---

# field-convert/10k-text-to-date-mixed

## Goal

Guard ISO parsing and invalid-value clearing while converting text to datetime.

## Seed Phase

Create `Title` plus `Date Text`; odd rows contain deterministic UTC ISO
datetimes and even rows contain invalid date tokens.

## Execute Phase

Convert to a date field with fixed UTC formatting.

## Primary Metric

- `convertTextToDateReadyMs` (initial guardrail: 15,000 ms).

## Verification

Require requested-engine routing and date target type. Valid rows must retain the
exact instant; invalid rows must become null across all 10,000 rows.

## Notes

Explicit UTC input avoids the display-format ambiguity of date-to-text conversion.
