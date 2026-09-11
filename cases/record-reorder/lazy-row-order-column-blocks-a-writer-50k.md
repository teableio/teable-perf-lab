---
owner: backend-v2
tags:
  - record-reorder
  - row-order
  - lock
  - contention
  - blocked-writer
  - 50k
  - v2
enabled: true
---

# record-reorder/lazy-row-order-column-blocks-a-writer-50k

## Goal

Measure how long an ordinary one-cell save takes while somebody else's insert
is building a view's row-order storage on the same 50,000-row table.

## Seed Phase

Create a 50,000-row table with a title and a note column and one grid view.
Nothing else: the point of the fixture is that no row in it has ever been
dragged into a manual order, so the view has no `__row_<viewId>` column yet.
That is the state the production table was in, and it is the state a table
reaches by being used normally — the lab does not arrange it.

## Execute Phase

1. Save one cell on the last row with nothing else running. This is the
   control, and it runs in the same process on the same fixture, because a
   baseline from another run is another machine-minute.
2. Confirm the view still has no row-order column, so the insert about to run
   will really take the lazy-creation path.
3. Insert one record anchored after the first row. This is the trigger, and its
   own latency is a diagnostic, never the gate.
4. Watch `pg_locks` until the trigger holds an `AccessExclusiveLock` on the
   table, then immediately save one cell on the last row again, and time that.
   If the lock does not appear within 150 ms the save is released anyway.
5. Verify the product recreated the row-order column, and that the second save
   is readable through the record API rather than lost to the contention.

## Primary Metric

`blockedWriterMs`: the second save's own latency — a request the case did not
cause and cannot speed up.

## Verification

The row-order column exists again after the trigger, and `getRecord` shows the
bystander's value. A run where the trigger finished before the bystander was
released fails loudly rather than reporting an unblocked number, because
nothing concurrent happened in it.

## Notes

Read `blockedWriterRatio` — `blockedWriterMs` over `blockedWriterBaselineMs` —
not `blockedWriterMs` alone. An absolute threshold on a latency this dependent
on disk would encode the runner's hardware; the ratio encodes the blocking. The
`maxMs` guardrail, 6,000 ms, exists to catch a stall that runs away entirely.

`lockObserved` describes the run, but it is not the verdict, and it is worth
being precise about why. Seeing the lock only means the watch caught the trigger
holding it at a 20 ms poll. The post-fix engine still takes this lock — `ADD
COLUMN IF NOT EXISTS` on a nullable column with no default is metadata-only — it
just does not hold it across the backfill. One of the `develop` runs below
caught exactly that, and its bystander was still not blocked. A run that saw the
lock is not a failing run; a run whose ratio is high is.

Measured locally at 50k rows, V2, three samples per commit, against
`0ad204535` (the parent of `daf0c3ca1e`) and `develop`:

| commit      | baseline        | bystander          | ratio              | trigger            | lock seen |
| ----------- | --------------- | ------------------ | ------------------ | ------------------ | --------- |
| `0ad204535` | 76 / 79 / 87 ms | 627 / 613 / 689 ms | 8.25 / 7.78 / 7.95 | 651 / 638 / 721 ms | 3 of 3    |
| `develop`   | 91 / 82 / 84 ms | 79 / 102 / 78 ms   | 0.87 / 1.23 / 0.93 | 650 / 739 / 683 ms | 1 of 3    |

Accepted in CI against `develop`, run 34575420378, both engines:

| engine | baseline | bystander | ratio | trigger | lock seen |
| ------ | -------- | --------- | ----- | ------- | --------- |
| V1     | 156 ms   | 900 ms    | 5.77  | 910 ms  | yes       |
| V2     | 137 ms   | 123 ms    | 0.89  | 1179 ms | no        |

The contrast reproduces on the runner's hardware, and so does the timing the
case depends on: the trigger lived 910–1179 ms there, well clear of the 150 ms
release window, so the bystander was released mid-trigger on both engines.
That was the one assumption a local run could not check.

V1 is kept rather than skipped, and it is green: one sample at the same scale
measured baseline 110 ms, bystander 763 ms, ratio 6.94, trigger 459 ms, lock
seen. The fix was V2-only, so that roughly sevenfold block is a standing
property of the V1 engine rather than a regression signal — which makes this
case a direct V1/V2 comparison of the same operation, one engine blocking a
bystander and the other not.

The trigger costs the same on both — every sample lands between 637 ms and
739 ms regardless of commit. That is the whole point of the case: before
`daf0c3ca1e` the cost was paid by whoever else was writing, and a lab that timed
only the insert would have called both columns healthy. Production hit this on a
166k-row table where the same lock was held for minutes (2026-09-09, repeated
site-wide 5xx waves).

## Open Assumptions

- 50,000 rows is the smallest fixture where the trigger reliably outlives the
  bystander's release on both engines; the incident's table was 166k. If the
  trigger ever stops overlapping, the case fails loudly rather than quietly
  measuring an idle writer.
- The 150 ms lock grace is shorter than the trigger on both sides of the fix
  and long enough for the pre-fix `ALTER TABLE` to take hold. It is a release
  timer, not a deadline.
- `maxMs` is 6,000 ms, calibrated from run 34575420378 at roughly 6.7x the
  slower engine's 900 ms. It is a runaway guard for a stall that escapes
  entirely — the production incident held the lock for minutes — not a
  benchmark, and the ratio remains the reading. One acceptance observation is
  thin for a metric whose value tracks the trigger's backfill, so widen it
  rather than chase a flake if CI history disagrees.
- The V1 column is reported without routing evidence: this runner asserts none,
  so the artifact cannot prove which engine served a request and the V1 reading
  rests on the harness's engine selection alone. Worth adding if that column is
  ever used as more than context.
