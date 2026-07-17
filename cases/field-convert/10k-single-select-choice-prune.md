---
owner: backend-v2
tags: [field-convert, single-select, choices, prune, 10k, v1-v2]
enabled: true
---

# field-convert/10k-single-select-choice-prune

## Goal

Guard same-type choice rename and removal across a populated single-select column.

## Seed Phase

Create stable-id choices `Todo`, `Doing`, and `Done`; values repeat evenly.

## Execute Phase

Keep the `Todo` id, rename it to `Planned`, and remove the other choices.

## Primary Metric

- `convertSingleSelectChoicesReadyMs` (initial guardrail: 15,000 ms).

## Verification

Require requested-engine routing and the single `Planned` choice. Former `Todo`
rows become `Planned`; all removed-choice rows become null.

## Notes

Stable ids model the UI update contract and distinguish rename from replacement.
