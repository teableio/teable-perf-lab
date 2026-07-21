---
owner: backend-v2
tags: [field, duplicate, 50k, single-select, scale-up, v1-v2]
enabled: true
---

# field-duplicate/50k-duplicate-status-field

## Goal

Scale populated single-select field duplication from 10k to 50k rows.

## Seed Phase

Reuse the shared 50,000-row scalar matrix containing all eight source field
types. Verify deterministic rows 1, 25,000, and 50,000 before execution.

## Execute Phase

Duplicate `Status` to `Status Copy` through the public endpoint. Time only the
request and routing assertion, then compare source and copy across all 50,000
rows and delete only the copy.

## Primary Metric

`duplicateScalarFieldMs`, with a 40-second failure ceiling. Seed, copied-value
verification, and cleanup are excluded.
