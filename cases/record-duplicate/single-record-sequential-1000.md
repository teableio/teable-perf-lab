---
owner: perf-lab
tags: [record-duplicate, scale-up, sequential, v1-v2]
enabled: true
---

# `record-duplicate/single-record-sequential-1000`

## Goal

Scale-up of `single-record-sequential-100`: sequentially duplicates all 1,000
source records from a deterministic 1,000-row, 20-field mixed table. The
primary metric remains per-request `duplicateSingleP95Ms`;
`duplicateSingleTotalMs` captures aggregate loop cost. V1/V2 routing and all
1,000 created rows are verified.

## Seed Phase

Create a deterministic 1,000-row source table and validate the source boundary before timing.

## Execute Phase

Duplicate each selected source row through the single-record endpoint, assert every response and V1/V2 route, then verify all duplicates and the final row count.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency across the sequential requests, maximum 2,000 ms.
