---
owner: perf-lab
tags: [record-duplicate, scale-up, sequential, v1-v2]
enabled: true
---

# `record-duplicate/single-500-single-select-10fields`

## Goal

Scale-up of `single-50-single-select-10fields`: sequentially duplicates 500
source records from a deterministic 1,000-row table with one primary text field
and nine single-select fields. The primary metric remains per-request
`duplicateSingleP95Ms`; `duplicateSingleTotalMs` captures aggregate loop cost.
V1/V2 routing and all 500 created rows are verified.

## Seed Phase

Create a deterministic 1,000-row source table and validate the source boundary before timing.

## Execute Phase

Duplicate each selected source row through the single-record endpoint, assert every response and V1/V2 route, then verify all duplicates and the final row count.

## Primary Metric

- `duplicateSingleP95Ms`: p95 latency across the sequential requests, maximum 2,000 ms.
