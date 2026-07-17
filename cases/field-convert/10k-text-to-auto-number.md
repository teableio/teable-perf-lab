---
owner: backend-v2
tags: [field-convert, text, auto-number, computed, 10k, v1-v2]
enabled: true
---

# field-convert/10k-text-to-auto-number

## Goal

Guard computed auto-number backfill while converting a populated 10,000-row text
column.

## Seed Phase

Create `Title` plus deterministic `Sequence Text` values.

## Execute Phase

Convert `Sequence Text` to auto-number and wait for the complete sequence.

## Primary Metric

- `convertTextToAutoNumberReadyMs` (initial guardrail: 30,000 ms).

## Verification

Assert route, auto-number target type, and computed metadata. Values must form
the row-ordered integer sequence 1 through 10,000.

## Notes

The wider initial threshold allows for computed backfill while CI history forms.
