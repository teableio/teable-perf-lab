---
owner: backend-v2
tags: [field-convert, checkbox, text, 10k, v1-v2]
enabled: true
---

# field-convert/10k-checkbox-to-text

## Goal

Guard conversion of checked and unchecked cells to text across 10,000 rows.

## Seed Phase

Create `Title` plus `Active`; odd rows are true and even rows are unchecked.

## Execute Phase

Convert `Active` to single-line text and wait for samples and a full scan.

## Primary Metric

- `convertCheckboxToTextReadyMs` (initial guardrail: 15,000 ms).

## Verification

Assert engine routing and target type. Checked rows must become `"true"`;
unchecked rows must remain null, matching Teable's V1/V2 parity contract.

## Notes

Seed validation treats false and the stored unchecked-null representation as
equivalent only before conversion.
