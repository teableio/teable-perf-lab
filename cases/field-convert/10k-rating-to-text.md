---
owner: backend-v2
tags: [field-convert, rating, text, 10k, v1-v2]
enabled: true
---

# field-convert/10k-rating-to-text

## Goal

Guard conversion of 10,000 option-bearing rating values to text.

## Seed Phase

Create `Title` plus a five-star `Score`; values cycle from 1 through 5.

## Execute Phase

Convert `Score` to single-line text and wait for complete read readiness.

## Primary Metric

- `convertRatingToTextReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert route and target type, then require each row to expose the expected score
string.

## Notes

Rating validation and metadata make this a separate boundary from plain number
conversion.
