---
owner: backend-v2
tags:
  - compute-activity
  - poll
  - contention
  - concurrency
  - write-load
  - 10k
  - v2
enabled: true
---

# compute-activity/poll-storm-under-write-load-10k

## Goal

Measure what a table's compute-activity poll costs when twenty viewers want the
projection at once **and** the engine is busy propagating writes to the same
table.

## Seed Phase

The same fixture as `compute-activity/poll-storm-20-viewers-10k`: a 10,000-row
table with five formula fields over a number column.

## Execute Phase

1. Poll `GET /api/v2/tables/getComputeActivity` twenty times from one viewer as
   the control.
2. Start two writers PATCHing 200 records each round, changing a value derived
   from the round so every write is real work to propagate.
3. Run the twenty-viewer poll storm alongside them. Both run at once on purpose:
   the contention this case is about is between computed workers and HTTP
   consumers sharing one process and one database pool, and a storm against an
   idle engine does not have it.

## Primary Metric

`pollP50Ms`: what a typical viewer waits while the engine is working.

## Verification

Every poll and every write must answer 200. A run with any failure fails rather
than reporting the latency of the requests that survived.

## Notes

Read this against its idle sibling `compute-activity/poll-storm-20-viewers-10k`,
which holds the same fixture and the same storm with no writers. The pair is the
measurement; either alone is a hardware reading.

Accepted in CI against `develop`, run 34582061316, both engines in hybrid mode
with no failed poll or write:

| engine | `pollP50Ms` | poll p95 | poll throughput | `writeP50Ms` | contention ratio |
| ------ | ----------- | -------- | --------------- | ------------ | ---------------- |
| V1     | 188 ms      | 245 ms   | 103/s           | 292 ms       | 7.73             |
| V2     | 194 ms      | 255 ms   | 99/s            | 189 ms       | 9.69             |

Polls cost roughly twice what they do on the idle sibling in the same
environment, which is the effect this case exists to hold a line under.

### What this case can and cannot settle

It was built to reach T7180 (`e656be5c3c`), which lowered the default outbox
worker concurrency from 8 to 2 so computed workers stop starving HTTP
consumers, and added a time budget that makes a worker yield between committed
stages. `V2_COMPUTED_OUTBOX_TRIGGER_CONCURRENCY` overrides that default, so the
pre-fix setting can be restored on one binary.

Four alternating pairs on `develop` in hybrid mode, concurrency 8 against 2:

| metric          | concurrency 8 (pre-fix) | concurrency 2 (post-fix) | 2 better in |
| --------------- | ----------------------- | ------------------------ | ----------- |
| `pollP50Ms`     | 108 / 112 / 108 / 93    | 99 / 109 / 102 / 103     | 3 of 4      |
| `pollP95Ms`     | 141 / 147 / 143 / 116   | 139 / 187 / 132 / 162    | 2 of 4      |
| poll throughput | 179 / 175 / 178 / 209   | 195 / 167 / 188 / 184    | 2 of 4      |
| `writeP50Ms`    | 108 / 110 / 107 / 90    | 98 / 108 / 102 / 102     | 3 of 4      |

**This does not separate them.** The signs flip between metrics and between
pairs, the median shifts are about 5%, and `pollP95Ms` is worse at the post-fix
setting by its median. Compare T7272's A/B on the same harness, which won 4 of 4
on two metrics and was still called too small to detect: this is weaker than
that.

So the case stays as a guardrail for polls under computed load — a scenario
worth watching whatever settles it — and T7180 stays a rejection in
`docs/triage-ledger.md`, now measured rather than assumed. Anyone returning to
T7180 should not start by building more harness: the harness exists, the write
load exists, and the effect did not appear. What is missing is an instrument
that resolves better than a wall clock, not more concurrency.

## Open Assumptions

- Two writers against twenty pollers was chosen so writes are continuously in
  flight without the write path becoming the bottleneck; at this ratio the
  writes sustain about 19 requests per second.
- Hybrid computed-update mode is required for this case to mean anything. In
  sync mode the outbox workers never run and the concurrency setting has no
  effect at all.
- `maxMs` is 2,000 ms, about 10x the slower engine in run 34582061316, matching
  the bound its idle sibling carries. The guard is for the read path collapsing
  under load, which would land in seconds; a contended median moves too much
  with the runner for a tighter bound to buy anything but flakes.
