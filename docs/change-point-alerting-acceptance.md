# Acceptance criteria: change-point perf alerting

- Status: Historical calibration; superseded for causal claims by ADR 0003
- Date: 2026-08-07
- Decisions on record: coverage of 1.5x and above is accepted (see H); the fast
  layer runs at the 0.99 quantile operating point (see A2).

> Methodology correction, 2026-09-01: V1 and V2 were separate GitHub-hosted
> matrix jobs, not same-machine paired observations. Figures below describe the
> detector that existed on the stated date and must not be used as calibration
> or causal evidence for the current global-run-effect detector. See
> [ADR 0003](adr/0003-separate-detection-from-causal-proof.md).

## What is being accepted

The replacement for the release-baseline comparison: a per-case time-series
system that reports at three time scales, and an incident ledger that accounts
for every regression it finds.

| Layer     | Answers                                        | When             |
| --------- | ---------------------------------------------- | ---------------- |
| Fast      | "this case looks wrong this run"               | same run         |
| Confirmed | "this is a regression, introduced by commit X" | a few runs later |
| Ledger    | "it escaped to production and lived N days"    | continuously     |

The goal is finding problems earlier. The ledger serves that goal rather than
competing with it: it is what makes the other two trustworthy over time, and it
is what turns "we think perf is fine" into a number.

## How it is measured

Not by watching production for a quarter. Every criterion below is measured
against the 143,350-row history already collected (2026-04-21 to 2026-08-06),
using three sources of ground truth:

**Permuted series — for false alarms.** Take a real series and shuffle the order
of its points. That destroys any real change point while preserving the case's
exact noise distribution, including its tail. Every change point reported on a
shuffled series is false by construction. This is the only false-alarm number
that can be trusted, because unshuffled history contains real regressions nobody
documented, and counting those as false alarms would flatter the result.

**Injection — for sensitivity and attribution.** Take a shuffled series, inject a
step of known size at a known position, and ask whether it is found and where.
Real noise, known truth, unlimited samples.

**Known incidents — for the end-to-end check.** The `record-read` regression is
verified: `50k-50fields-sort-three-fields` moves 4.31s to 9.05s across the
corpus. Any pipeline that cannot find that one is broken regardless of what the
synthetic numbers say.

Measurements are per engine and reported for v2. v1 is the control channel, not
a subject.

## A. Detection accuracy

All figures below are measured, not proposed. Method: 287 real v2 series
(median 138 points), shuffled for false alarms, injected for sensitivity,
confirmed-layer gate at 1x the case's own robust sigma, 40 trials per cell.

Sensitivity is measured with a **lone** injected regression — one case broken in
an otherwise clean run — because that is what actually happens, and because it
is the hardest case for the FDR correction. Every "detected" below also required
attribution within +/-1 commit; a report that named the wrong change does not
count as a catch.

**A1. False alarms, confirmed layer.** Measured **0.0 per run** at every gate
from 1 to 3 sigma, across 287 shuffled series x 2 replicates. Bar: **<= 1 per
run**. Today's gate fires on 29.9% of cases from noise alone — roughly 117 per
run.

**A2. False alarms, fast layer.** The threshold is the empirical quantile of the
case's own deviation distribution, calibrated on its history and applied only to
the newest point. Sigma multiples were tried first and are the wrong shape: the
noise has a heavy tail (p90 1.193 against a 1.101 median), so at a matched
false-alarm rate the quantile form catches 2.6x more.

| threshold      | false alarms/run | 1.5x caught | 1.2x caught |
| -------------- | ---------------- | ----------- | ----------- |
| sigma x6       | 2.0              | 10%         | 2%          |
| quantile 0.995 | 2.0              | 26%         | 7%          |
| quantile 0.99  | 4.0              | 35%         | 11%         |
| quantile 0.98  | 6.3              | 46%         | 16%         |
| quantile 0.95  | 16.3             | 62%         | 29%         |

**Operating point, decided: quantile 0.99** — 4 false alarms per run, 35% of
1.5x regressions caught in the run they land. Bar: **<= 5 false alarms per
run**. The looser points were available and were not taken: 0.98 buys 11 more
points of recall for 2 more false alarms a run, and 0.95 buys 27 more for 12
more, which is the direction that made the current card unreadable.

**A3. Sensitivity, confirmed layer.** Measured:

| Injected | 10 runs after | 20 runs after | Bar          |
| -------- | ------------- | ------------- | ------------ |
| 2.0x     | —             | 98%           | >= 95% at 20 |
| 1.5x     | 75%           | 83%           | >= 70% at 10 |
| 1.2x     | —             | 35%           | none — see H |

**The 1.2x bar in the first draft was >= 70% and is not achievable.** The
confirmed layer resolves 1.5x and larger reliably and does not resolve 1.2x.
That is a property of the noise, not of tuning: a quarter of cases move more
than 24% between two runs of identical code. Whether 1.5x-and-up coverage is
enough is a decision, and it is recorded in H rather than papered over by moving
the bar to meet the measurement.

**A4. Sensitivity, fast layer.** At the 0.99 operating point: 35% of 1.5x and
11% of 1.2x regressions are flagged in the run they appear. No bar on 1.2x.

**A5. Attribution.** Folded into A3 — a detection only counted if it named a
commit within +/-1 of the true injection point.

**A6. Reproduction.** **Passes.** Run against the real corpus the pipeline
localises the known `record-read` regression to the adjacent mainline pair
#2599 -> #2600 on two independent cases (`50k-50fields-sort-three-fields` 4.25s
-> 9.14s, `50k-50fields-group-number-low-cardinality` 2.69s -> 7.28s), both at
p = 1e-4. Both endpoints are measured, so the attribution is exact to a single
teable-ee commit, `a7c04bf9`. What that commit changed is not recorded here:
this repository is public and teable-ee is not, so findings name a commit and
stop there. The description belongs in the internal issue.

## B. Timeliness

**B1.** The fast layer reports in the run itself.

**B2.** A 1.5x regression reaches 75% detection 10 runs after it lands and 83%
at 20. Bar: **>= 70% within 10 runs**.

**B3.** The confirmed layer's floor is stated in the report, not buried: a
regression introduced by the newest commit cannot be confirmed from one
measurement, and the card must not imply otherwise. The live example is
`group-number-low-cardinality`, which sat at 7.3s through #2668 and read 1.3s at
#2670 — one point, which the confirmed layer correctly refuses to call a fix and
the fast layer correctly flags as worth a look.

## B4. Known limitation: fast fixes are poorly recorded

Sections A and B measure a regression that was introduced and left in place.
Measured separately, on 277 real series, for one that was introduced and later
reverted — where recording the incident means finding **both** edges:

| Regression | Lived ~2 weeks | ~1 week | ~3-4 days |
| ---------- | -------------- | ------- | --------- |
| 2x         | 91%            | 83%     | 47%       |
| 1.5x       | 73%            | 55%     | 12%       |

So the promise that a hotfix cannot erase the history holds for incidents that
lasted, and weakens sharply for ones fixed within a few days. The perverse
consequence is worth stating plainly: **the faster a team fixes something, the
less likely this system remembers it happened**, which flatters the record of
exactly the teams that respond well.

A windowed second detection pass was added and tuned for this and recovered
part of it (1.5x at one week went from 40% to 55%); tuning stopped there. Six
measurements cannot carry a distribution test at any window size, so this is a
floor of the method rather than a setting.

Two consequences, both accepted rather than solved:

- The ledger needs a manual entry path. What the detector cannot see, a person
  who was there can record.
- No count drawn from the ledger may be presented as a complete incident
  history. It is a lower bound, and reports must say so.

This does not touch anything found so far — the `record-read` incident had run
8 days, the foreign-key one is still open, and all 44 entries on the first
triage list are unclosed.

## C. Ledger completeness

**C1.** Replaying the entire history end to end produces a ledger where every
confirmed change point is either paired with its fix or open. No change point
ends in an undefined state.

**C2.** An escaped regression — one whose entry commit was released before its
fix — carries entry commit, fix commit (or open), and days in production.

**C3.** Known-good commit, computed as the most recent commit with no open
incident, agrees with a manual reading of the history on 5 spot checks.

**C4.** Every row excluded from the corpus is counted under a reason and the
totals are printed. A corpus that silently shrank is indistinguishable from one
that was always small.

## D. Card readability

The card is read by the whole team including the boss, so it is accepted against
both readings.

**D1. Ten-second reading.** From the card alone, without opening anything, a
reader can answer: is there anything new, how many open incidents are there, is
that better or worse than last week.

**D2. Actionable detail.** Every listed item names the case, the commit that
introduced it, the magnitude, and its state. A reader deciding whether to act
does not need a second tool.

**D3. Silence.** When nothing happened, the card says so in one line — and that
line is only permitted once A1 holds, because "nothing new" from a system with
today's false-alarm rate would be a lie.

**D4.** Reviewed as a mock before implementation.

## E. Engineering

**E1.** Same input, same output. Every detector is seeded; a disputed alert can
be re-derived.

**E2.** Every model has checks wired into `pnpm check`.

**E3.** Reading Performance Track goes through aggregate SQL. No path fetches
raw records to compute something a `GROUP BY` answers, and no query selects the
long-text columns.

**E4.** No credentials in the repo.

## F. Cost per run

Performance Track is 143,350 rows today and grows by roughly 10,000 a month.
Anything whose per-run cost tracks that number stops being affordable on its own
schedule, so the cost model is part of what is accepted, not an afterthought.

**F1. Cost does not scale with table size.** Per-run work is bounded by the case
count times the look-back window, both constants. Verified by running the whole
per-run path against a corpus with its history doubled and confirming the time
does not move more than 20%.

**F2. Per-run wall clock ≤ 30s** for the analysis stage, excluding the Teable
read. Measured on the 2026-08-07 corpus, the pieces are:

| Stage                               | All 287 series    | Runs when               |
| ----------------------------------- | ----------------- | ----------------------- |
| Fast layer                          | 0.3 ms            | every run               |
| Screen — one sweep, no permutations | 16 ms             | every run               |
| Full permutation test               | 159 ms per series | only screened survivors |

Testing every series at full permutation is 46s, which is the number this
criterion exists to keep the design away from. A typical run has a handful of
survivors, so the expected cost is under a second.

**F3. Teable reads are incremental.** ~~The corpus is append-only — settled
history never changes — so a run fetches only its own rows, one page, one
query.~~ **Not adopted, 2026-08-21.** The nightly run rebuilds the whole corpus:
325 paged queries, 3m33s, inside a step that takes about 22 minutes and a job
that allows 40.

The saving is real and it is three and a half minutes a night. What it costs is
the property that makes the corpus trustworthy — that every run derives it from
Performance Track and from nothing else. An incremental corpus is a cached
corpus, and a cache that goes subtly wrong here does not fail: it produces a
complete-looking history with a stretch missing, and every detector downstream
reports confidently off it. This project has shipped that exact failure four
times (a shallow clone reading one commit of history, a seen-set built under a
different window, a reconciliation pointed at the wrong file, a card step
dropping a field it did not know about), and each one was found late because a
wrong answer and a right answer look the same in a JSON file.

Three and a half minutes a night does not buy that risk. The measured growth is
about 10,000 rows a month, roughly 25 more pages, about 20 seconds a month — so
the arithmetic that makes this the right call holds for something like a year.
It is the arithmetic, not the preference, that decided it: if the corpus build
ever approaches the step's own budget, this is a different question with
different numbers.

**F4. History is not re-derived.** ~~Once a change point is confirmed and
written to the ledger, the series before it is settled and is not searched
again.~~ **Not adopted, 2026-08-21**, and the measurement that killed F3 is not
even the main reason here. Re-deriving the whole series every night is what
found 62% of the confirmed change points: older boundaries become confirmable as
measurements accumulate behind them, and a detector that never looks back at a
settled segment cannot find those at all. Freezing history would trade a
detection the system demonstrably makes for a saving of 45 seconds.

**F5. Drift sweeps are scheduled, not per-run.** Accumulated drift is by
definition slow, so the full-window sweep that catches it runs on a schedule
(daily or weekly). Nothing that can wait a day is allowed into the per-run path.

Note on what is deliberately not done: the E-Divisive statistic has no O(1)
incremental update — adding one point changes it at every candidate split. That
is fine, and chasing it would be a mistake. Recomputing the whole sweep costs
16 ms, which is cheaper than maintaining incremental state and carries none of
the risk of that state silently diverging from the data.

## G. Shadow validation, before anything switches

**G1.** The new system runs alongside the existing report for at least 10 full
runs, writing to the ledger without raising alerts.

**G2.** The false-alarm rate measured over those runs is within 2x of what the
backtest predicted. If it is not, the backtest method is wrong and nothing
switches until that is understood — this is the criterion that catches a
measurement approach that flattered itself.

**G3.** Every alert the old system raised during shadow that the new one did not
is reviewed by hand, and each is classified as noise the new system correctly
ignored or a miss that needs explaining.

**G4.** The old comparison is retired only after G1–G3 pass. Retiring means the
20% computation stops driving the card. The Performance Track table, its
history, and the code in git are untouched.

## H. What would mean this approach failed

Stated before the measurement, and now answered by it.

The original condition was: fewer than 2 false alarms per run while detecting at
least 70% of 1.2x regressions. **Half of it passed and half of it failed.**
False alarms measured 0.0. Detection of 1.2x measured 35%.

The bar is not being lowered to fit. The finding is that the confirmed layer
resolves 1.5x and above (83-98%, exact attribution, no false alarms) and does
not resolve 1.2x, and the decision of whether that is enough belongs to whoever
signs this off, not to the measurement.

**Decided 2026-08-07: 1.5x-and-up coverage is accepted** and the plan proceeds
as written. The regression this system found in the real history was 2.16x and
2.76x, comfortably inside the range it resolves.

That decision is revisitable in one direction only. If 1.2x coverage is ever
required, no amount of tuning produces it on this data — the noise would have to
come down at its source, through more repeats per commit or quieter runners.
Recording that here so the answer is not re-derived from scratch later.

The fast layer keeps a weak signal on 1.2x (11% at the chosen operating point).
It is reported as a hint and must never be presented as coverage.
