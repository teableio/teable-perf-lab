---
owner: perf-lab
tags: [record-redo, selection, scale-up, v1-v2]
enabled: true
---

# record-redo/delete-10k

## Goal

Scale redo of a selection delete from 1,000 to 10,000 mixed records.

## Seed Phase

Build and validate a deterministic 10,000-row, 20-field table, then perform delete and undo setup.

## Execute Phase

Redo the delete through the stream endpoint, assert terminal routing/events, and verify the table is empty.

## Primary Metric

- `redoReplay10kMs`: redo stream latency, initial maximum 30,000 ms.
