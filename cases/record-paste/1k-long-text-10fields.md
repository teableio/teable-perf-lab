---
owner: backend-v2
tags:
  - record-paste
  - paste
  - 1k
  - field-matrix
  - long-text
  - v1-v2
enabled: true
---

# record-paste/1k-long-text-10fields

## Goal

Measure grid paste performance for 1,000 records in a ten-field table dominated
by long-text payloads.

## Seed Phase

- No reusable records are seeded.
- Execute setup creates an empty table with `Title` plus nine long-text fields
  and builds the deterministic 1,000 × 10 TSV payload before measurement.

## Execute Phase

1. Paste the text/long-text block into the empty table.
2. Assert response and engine-routing evidence.
3. Stop the timer, then full scan all 1,000 records and verify every payload.
4. Preserve samples for rows 1, 500, and 1,000 and delete the scratch table.

## Primary Metric

- `paste1kMs`: elapsed time for the paste request and response assertions;
  calibrated guardrail `maxMs: 6_000`.

## Notes

The nine long-text columns use deterministic, field-specific strings so the
readback proves the complete clipboard block was stored. Verification and
cleanup are outside the timer. V1 uses range paste; V2 uses paste-by-id.
