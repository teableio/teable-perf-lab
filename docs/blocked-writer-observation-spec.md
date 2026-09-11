# Blocked-writer observation spec

Status: implemented, with two corrections from the first case built on it —
see "What the first case changed". Owner: perf-lab. Target: a second measured
session, and the cases that need one.

## Why

Every runner in this lab drives one client through one operation and times it
to readiness. That shape cannot express a whole class of production incident:
the ones where the request that suffers is not the request that causes the
problem. A schema operation takes a table-wide lock; some unrelated person's
save sits behind it for two minutes; the page shows an error. The causing
request may itself look perfectly healthy — and does, when one client measures
it alone.

`record-mutation-lifecycle` names this gap in its own scope note: the driver
"assumes one primary measured operation against a reusable fixture", and "a
broader abstraction should wait for a family that breaks one of those remaining
assumptions". This is that family.

The trigger is teable-ee `daf0c3ca1e` / `fdd6b71444` (T7251). A lazily created
`__row_<viewId>` column used to run `ALTER TABLE ADD COLUMN`, a full-table
backfill `UPDATE`, and `CREATE INDEX` inside the caller's request transaction.
On a 166k-row table in CN production on 2026-09-09 the `AccessExclusiveLock`
was held for minutes and blocked every session touching the table, in repeated
site-wide 5xx waves as each killed attempt rolled back and re-armed the trap.
The fix moves creation onto a non-transactional handle: fail-fast `ADD COLUMN
IF NOT EXISTS` under a 3s `lock_timeout`, a chunked autocommit backfill, and
`CREATE INDEX CONCURRENTLY`.

The quantity that changed is the latency of a **bystander** write. There is no
way to phrase that as one client doing one thing.

## What is measured

**Blocked-writer latency**: the wall clock of an ordinary write issued by a
second session while a first session is inside the operation under test.

The case reports three numbers, and all three are needed to read it:

- `blockedWriterMs` — the bystander write's own latency, the primary metric.
- `blockedWriterBaselineMs` — the same write, same fixture, same session, with
  no concurrent operation. The control.
- `triggerMs` — the causing operation's latency. A diagnostic, never the gate:
  the whole point is that this number can be healthy while the case fails.

The verdict is the ratio of the first to the second. An absolute threshold on
`blockedWriterMs` would encode this machine's disk speed; the ratio encodes the
blocking.

## The two hard problems

Neither is about writing a runner. Both must be settled before one is written,
because a runner that guesses at either produces a number that looks like a
measurement and is not one.

### 1. Proving the writer was blocked, not merely slow

A second request issued at the same time as a first is slower for reasons that
have nothing to do with locks: connection-pool contention, the event loop, the
database competing with itself for buffers. If the case simply fires two
requests and times the second, a run where nothing blocked and a run where
everything blocked differ only in degree, and the threshold that separates them
is a guess about this machine.

Three requirements fall out:

- **The bystander must start after the trigger has taken its lock**, not
  merely after the trigger request was sent. Sending both at once measures a
  race. The ordering seam has to be observable — the trigger request having
  been accepted is not the same as its transaction holding the lock.
- **The no-contention control runs in the same case, on the same fixture, in
  the same process**, immediately before or after. A baseline from a different
  run is a different machine-minute.
- **The bystander must touch the locked table and nothing else.** A write that
  also recomputes a formula chain buries the lock wait under compute.

The honest form of the ordering seam is probably to poll `pg_locks` for the
trigger's `AccessExclusiveLock` on the target relation before releasing the
bystander, which is a `SELECT` and therefore already inside what
`framework/sql.ts` allows. That keeps the harness's evidence in the same
currency as its assertion: the case can record _which_ lock it waited for, so
a green run proves the trap was armed rather than proving nothing happened.

### 2. Arming the trap at all

**This turned out not to apply. Kept because the reasoning was wrong in an
instructive way — see the correction below.**

The state the fix needs is a grid view whose `__row_<viewId>` column does not
exist. `visitTableAddView` creates, backfills and indexes that column as part
of a view-add, so the expectation here was that a case would have to reach
around the product API — as the fix's own e2e does, dropping the column with
raw SQL — and that `queryPerfDb` refusing anything but a `SELECT` would block
it. That would have wanted a declared fixture-DDL seam in the shape of
teable-e2e-lab's `fixture-db`.

## What is measurable today, and why it is not this case

Adding a grid view to a large table runs `ADD COLUMN` + full backfill +
`CREATE INDEX` inside one transaction **on both sides of the fix**. The
follow-up commit `fdd6b71444` says so and documents the residual lock window on
big existing tables as deferred, because `CONCURRENTLY` is illegal inside a
transaction block and the schema batch may already hold locks.

That path needs no second session to time — the view-add request wears its own
cost. It is a real guardrail over a known-deferred risk, and worth having. It
is not a T7251 case: it measures the window the fix chose to keep, and it would
read identically on `0ad204535` and on `develop`. Anyone building it should say
that in the case description, or the next reader will take a flat line as proof
the fix works.

## What the first case changed

`record-reorder/lazy-row-order-column-blocks-a-writer-50k` was built on this
spec and settled two of its guesses by measurement.

**The trap needs no DDL.** A view only gets row-order storage when something
actually needs manual sort order. A table that was seeded and read but never
reordered has no `__row_<viewId>` column at all — the local database has zero
such columns across every table in it. So the state the fix needs is not a
contrived one the API refuses to produce; it is the ordinary state of a table
nobody has dragged a row in, which is exactly why this was a production
regression rather than a bug someone had to construct. The case asserts the
column is absent before the trigger rather than arranging for it, and a
fixture-DDL seam was written and then deleted unused. `queryPerfDb` stays
SELECT-only.

**Seeing the lock is not the verdict.** The post-fix engine still takes an
`AccessExclusiveLock` — `ADD COLUMN IF NOT EXISTS` on a nullable column with no
default is metadata-only — it just does not hold it across the backfill. One
`develop` sample caught that lock at a 20 ms poll and its bystander was not
blocked. So `lockObserved` describes a run; the ratio judges it. A harness that
had gated on the lock alone would have called that sample a regression.

The shape that did hold is the important one: across six samples the trigger
cost 637–739 ms regardless of commit, while the bystander went 8x on the
parent and ~1x on `develop`. A lab that timed the causing request would have
found both columns healthy.

## What this unlocks beyond T7251

The compute-activity family — T7180 (`e656be5c3c`), T7272 (`bbcecdbfb4`),
T7181 (`74e773822e`) — is in `triage-ledger.md` for a neighbouring reason: the
quantity that moves is per-poll server work under many simultaneous viewers of
one table. That wants N concurrent readers rather than one concurrent writer,
but it wants the same thing from the harness: more than one measured session,
released in a known order, reported separately. Build the seam so the second
session is a list rather than a singleton and the three of them become
reachable without a third harness.

## Open questions

- Where the second session lives. A second axios client in the same process
  shares the Node event loop with the first, which puts the thing being
  measured and the thing measuring it on one thread.
  `framework/isolated-json-request.ts` already runs a request in a worker for
  exactly this kind of reason and is the first place to look.
- Whether the trigger and bystander can share a seed fixture. They must touch
  the same physical table, so they cannot be isolated from each other by
  construction — which means cleanup has to reason about a fixture two sessions
  mutated.
- What the artifact says on a run where nothing blocked. "Fast" and "the trap
  was never armed" must not be the same artifact.
