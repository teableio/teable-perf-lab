---
owner: backend-v2
tags: [field-convert, number, rating, clamp, 10k, v1-v2]
enabled: true
---

# field-convert/10k-number-to-rating-clamped

## Goal

Guard number validation and upper-bound clamping during rating conversion.

## Seed Phase

Create `Title` plus `Rating Input`; values cycle from 1 through 8.

## Execute Phase

Convert the number field to a five-star rating.

## Primary Metric

- `convertNumberToRatingReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert route, rating type, and max metadata. Values 1–5 must remain unchanged;
6–8 must clamp to 5 across the full scan.

## Notes

Out-of-range rows force an actual value rewrite instead of a metadata-only change.
