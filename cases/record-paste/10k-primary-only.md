---
owner: backend-v2
tags: [record-paste, 10k, primary-only, v1-v2]
enabled: true
---

# record-paste/10k-primary-only

## Goal

Measure one 10,000-row paste into a primary-only table. Compared with
`record-paste/1k-primary-only`, only row count changes.

## Seed Phase

Create an empty table with only the primary `Title` field and build a
deterministic 10,000-line clipboard payload.

## Execute Phase

Paste all rows in one request and assert V1/V2 paste routing.

## Primary Metric

- `paste10kMs`: paste endpoint request time only; initial `maxMs` is 20,000.

## Verification

Scan all 10,000 pasted rows and verify rows 1, 5,000, and 10,000.
