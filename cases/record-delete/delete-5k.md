---
owner: perf-lab
tags: [record-delete, selection, scale-up, v1-v2]
enabled: true
---

# record-delete/delete-5k

## Goal

Scale synchronous selection delete from 1,000 to 5,000 mixed records.

## Seed Phase

Build and validate a deterministic 5,000-row, 20-field table.

## Execute Phase

Delete the full selection, assert V1/V2 routing and returned ids, then verify the table is empty.

## Primary Metric

- `delete5kMs`: selection-delete request latency, initial maximum 10,000 ms.
