---
owner: backend-v2
tags:
  - compute-activity
  - poll
  - contention
  - concurrency
  - 10k
  - v2
enabled: true
---

# compute-activity/poll-storm-20-viewers-10k

## Goal

Measure what a table's compute-activity poll costs when twenty viewers of that
table all want the same projection at once.

## Seed Phase

Create a 10,000-row table with a text and a number column, then add five
formula fields over the number. The formulas are what give the activity
projection something to report; a poll that reads an empty projection is not
the poll production pays for.

## Execute Phase

1. Poll `GET /api/v2/tables/getComputeActivity` twenty times from a single
   viewer. This is the control: without it a slow storm cannot be told from a
   slow endpoint.
2. Run twenty viewers, twenty rounds each, no think time, each keeping one
   request in flight — the shape a table open in twenty browser tabs produces.
   All of it runs on a worker thread, because the harness boots the server in
   this process and a poller on the main thread would partly be timing itself.

## Primary Metric

`pollP50Ms`: what a typical viewer waits during the storm.

## Verification

Every poll must answer 200. A run with any failed poll fails the case rather
than reporting the latency of the ones that survived.

## Notes

Read `pollP50Ms` and `pollThroughputPerSec` together, and read both against
`soloPollP95Ms` from the same run — `pollContentionRatio` is that comparison
made explicit. An absolute latency here is mostly a statement about the
runner's hardware.

The primary metric is the median rather than a tail percentile on purpose. See
the measurement below: the median and the throughput moved together in every
pair, and the tails did not separate.

### What this case can and cannot settle

It was built for T7272 (`bbcecdbfb4`), which coalesces the compute-activity
read so that a repeat poll inside the TTL costs no database transaction.
Because that coalescer is switched by `COMPUTED_ACTIVITY_READ_CACHE_MS`, it can
be measured on **one binary** rather than across two checkouts — which removes
the largest source of error in a local comparison. Four alternating pairs on
`develop`:

| metric               | coalescer on          | coalescer off (`=0`)  | median shift |
| -------------------- | --------------------- | --------------------- | ------------ |
| throughput (polls/s) | 233 / 248 / 199 / 233 | 207 / 180 / 192 / 212 | +12.7%       |
| `pollP50Ms`          | 83 / 76 / 93 / 83     | 94 / 108 / 98 / 91    | −15%         |
| `pollP95Ms`          | 110 / 110 / 149 / 104 | 115 / 141 / 140 / 110 | overlapping  |

The coalescer is faster in four pairs out of four on both the median and the
throughput, and the direction never flips. That is the right sign and a
plausible size for what it does.

It is also, honestly, about the size of this lab's own noise: the
Performance Track corpus moves 13–16% between consecutive runs that did
identical work. **So this case cannot, from one observation, tell whether the
coalescer is present.** It is a floor guard — it would catch the read path
regressing by a lot, and its harness is the reusable part — not a T7272
regression detector. Treat a single run's shift as unproven unless it is large.

T7180 (`e656be5c3c`) and T7181 (`74e773822e`) are the same family and stay open
in `docs/triage-ledger.md`. They should reuse this runner rather than start
over.

## Open Assumptions

- Twenty viewers with no think time saturates the endpoint deliberately, to
  make the effect as large as it gets. Production's shape was gentler — about
  2.4 requests per second per pod, with half the polls repeating the same
  table within a second — so this case exaggerates on purpose and should not be
  read as a capacity model.
- The 5-second `maxMs` is a runaway guard against the median poll collapsing,
  not a benchmark, and nothing has yet run it in CI.
