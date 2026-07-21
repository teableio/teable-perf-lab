---
owner: backend-v2
tags: [field, duplicate, 50k, single-line-text, scale-up, v1-v2]
enabled: true
---

# field-duplicate/50k-duplicate-owner-text-field

## Goal

Scale populated single-line-text field duplication from 10k to 50k rows.

## Seed Phase

Reuse the shared 50,000-row scalar matrix containing `Title`, `Owner Text`,
`Description`, `Amount`, `Start Date`, `Active`, `Status`, `Tags`, and `Score`.
Verify deterministic rows 1, 25,000, and 50,000 before execution.

## Execute Phase

Duplicate `Owner Text` to `Owner Text Copy` through the public endpoint. Time
only the request and routing assertion, then compare source and copy across all
50,000 rows and delete only the copy.

## Primary Metric

`duplicateScalarFieldMs`, with a 40-second failure ceiling. The 50k fixture is
the scale variable; seed, verification, and cleanup are excluded.
