# Triage ledger

teable-ee commits that were examined as performance-case candidates and
**deliberately not turned into one**, with the reason.

This is the negative half of an answer the repository already gives in
positives: a case that settles a product fix names it in its description, and
those two lists together are what lets the next triage pass skip what has
already been decided and spend its time on what has not. A commit that produced
a case announces itself; a commit that was read, reasoned about and rejected
leaves no trace at all, so the next pass re-derives the same conclusion at the
same cost — and the more careful the rejection, the more expensive it is to
repeat.

A row is a decision about this repository, not a verdict on the fix. "Not
taken" means the lab cannot separate the fix's parent from `develop` honestly
today. If that changes — a new harness, a different observation point — delete
the row and write the case.

The sibling ledger in teable-e2e-lab holds the commits rejected there for
behavioral regression cases; several rows below arrived from it, marked as a
performance shape that repository could not express.

## Not taken

| commit                     | issue | why not                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `468cbd29f7`               | T7075 | Written and run, in two fixture shapes, against the fix's parent `0ad204535` and `develop`. A host table and a line table joined by one real link, N rollups over that one link each filtered to its own line kind, then one line per host updated so every host goes dirty. At 2,000 hosts x 10 lines the propagation metric was 912 ms / 1,843 ms (1 and 10 rollups) on the parent against 1,168 ms / 3,164 ms on `develop`; at 2,000 hosts x 50 lines it was 1,019 ms / 2,024 ms against 1,607 ms / 2,150 ms. The ten-rollup number never improved, and the one phase that did move — the field-creation backfill — moved 2,004 ms -> 4,603 ms at fanout 10 and 4,213 ms -> 2,137 ms at fanout 50, opposite signs on the same pair of commits. That is run-to-run variation, not the fix. See the note below the table. |
| `3dbe1be547`               | T7145 | An omnibus of ten changes — formula parse/compilation caches, deterministic scalar lowering, array pipeline fusion, frontier pruning of unchanged downstream work, scalar backfill widening, batched host link reads. Each moves the same wall clock the existing `formula/*` and `lookup/customer-*` cases already measure, so a new case would not isolate any one of them; it would only restate the corpus. What this lab is missing is not a case but an attribution: which of the ten the corpus moved on. That belongs to the paired base/candidate lane, not to a new fixture.                                                                                                                                                                                                                                     |
| `e656be5c3c`               | T7180 | Worker and query contention: outbox trigger budgets, stage-plan splitting, worker wake-up behaviour. The win is concurrent throughput across pollers and workers; the lab drives one client and times one operation to readiness, so a healthy single-client run measures the same number on both sides of the fix. A concurrent-load harness would change this answer.                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `bbcecdbfb4`               | T7272 | Per-pod coalescing of compute-activity reads: a repeat poll inside the TTL costs zero transactions instead of one. The quantity that moves is transactions per pod under many simultaneous viewers of one table, which the commit proves against real Postgres by counting them. The lab has one client, no poll-storm runner, and no transaction counter; at one request at a time, HTTP overhead dominates whatever the coalescer saves. Same blocker as T7180.                                                                                                                                                                                                                                                                                                                                                          |
| `74e773822e`               | T7181 | Skips the reconciliation heal on budgeted ShareDB and activity polls. The saving is per-poll server work on a path the lab reaches only incidentally, and never at the poll rate that makes it visible. Same family, same blocker, as T7272 and T7180.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `fdd6b71444`, `daf0c3ca1e` | T7251 | The closest call here. Lazy `__row_<viewId>` creation used to hold an `AccessExclusiveLock` for the whole ADD COLUMN + backfill + CREATE INDEX, so the symptom is a **second** session's write stalling behind the first — a latency a perf lab should own. The lab cannot express it: every runner drives one client through one operation, and nothing holds a concurrent writer whose latency is the measurement. `framework/concurrency.ts` is a bounded map for trace fetching, not a contention harness; `formula/10k-5-concurrent` is five formula fields, not five clients. Take this one as soon as a two-session runner exists, on a table large enough (the incident was 166k rows) for the stall to outlive the noise.                                                                                         |
| `7ac08790e4`               | T7209 | Coalesces ShareDB field snapshots and moves compute-activity subscription to the table document. The reconnect storm it fixes is a websocket and browser-SDK path — SockJS reconnect jitter, per-field subscriptions, op-batch debouncing. The lab speaks HTTP to the API; the storm never forms here, so there is nothing to time.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `2c9ebe6532`               | T7139 | Shares formula subexpressions so the generated SQL stops growing with repeated references. The quantity is the size and shape of the generated statement, which the commit measures directly in its own SQL snapshots — a better instrument than wall clock, and one this lab does not read. Wall clock would only see it through plan time on very wide formulas, well inside run-to-run noise.                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Notes

### `468cbd29f7` / T7075

The fix makes a dirty-host computed update plan filtered link rollups as one
shared set-based group scan instead of one correlated LATERAL per filter, and
its own description names ten filtered rollups on one link exceeding
`statement_timeout` as the production symptom. The case that would settle it is
therefore a curve: hold one fixture, vary only how many filtered rollups share
the link, and read the gap between two points rather than either point alone.

That case was built — a `filtered-link-rollup` runner on
`record-mutation-lifecycle`, a host/line fixture whose kind ring is fixed so
every rollup count shares one seed, and a 1-rollup control beside a 10-rollup
subject. It ran clean on both commits: routing matched, every host row
full-scanned, every rollup's exact sum verified. What it did not do is separate
the two commits. Ten filtered rollups cost about twice one filtered rollup on
both sides of the fix, at both fanouts tried, and the residual differences
between the commits were smaller than the differences between runs of the same
commit.

The likely reason is scale rather than shape: at 2,000 dirty hosts the
per-host correlated lookup is an index hit over at most fifty foreign rows, so
the plan the fix replaced was never the expensive part. The production incident
had an order of magnitude more rows. Reviving this needs either a fixture large
enough for the pre-fix plan to dominate — which is a seed this lab would pay
for on every full run — or the same-host paired base/candidate lane, where ten
matched pairs on one machine can resolve an effect this small and a single
local sample cannot.

## Taken

Nothing from this batch. The 2026-09-11 pass over the teable-ee fixes that
teable-e2e-lab rejected as performance shapes produced seven rows above and no
case. T7075 came closest and is the only one whose case was actually written
and run; the rest were rejected on the instrument, not on the numbers.
