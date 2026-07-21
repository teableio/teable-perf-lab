---
owner: perf-lab
tags: [duplicate-table, self-link, scale-up, v1-v2]
enabled: true
---

# duplicate-table/10k-20f-selflink-2k-links

## Goal

Scale populated self-link cells from 500 to 2,000 while keeping the 10,000-row, 20-field table fixed.

## Seed Phase

Build the deterministic mixed table and populate 2,000 one-way self links.

## Execute Phase

Duplicate the table with records, assert V1/V2 routing, and scan all 10,000
copied rows. V2 must contain exactly 2,000 populated self-link cells with the
expected next-row targets. The V1 artifact explicitly records the legacy path's
missing one-way self-link field.

## Primary Metric

- `duplicateTableRequestMs`: duplicate-table request latency, initial maximum 60,000 ms.
