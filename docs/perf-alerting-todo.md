# Perf alerting: where this stands and what is left

Written 2026-08-07 to be picked up cold. Everything needed to resume is here or
linked from here.

## What this project is

Replacing the release-baseline perf comparison. The old one compares each run
against whichever commit is currently released, and that reference moves: a
regression that ships becomes the new baseline, and a hotfix moves the reference
again so the incident leaves no trace. Measured, its 20% gate also fires on
29.9% of cases from noise alone — about 117 of 393 per run with identical code.

The replacement reads each case's own history instead of an external reference,
at three time scales: a same-run check, a confirmed change point a few runs
later, and an incident ledger.

Goal as the owner stated it: **find problems earlier, with accounting that
serves that goal**, and one card the whole team including the boss can read.

Acceptance criteria are signed off in
[change-point-alerting-acceptance.md](change-point-alerting-acceptance.md) —
every number in it measured on the real 143,350-row history, not proposed.

## Done, merged, and validated

|                                       | Measured                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Confirmed layer false alarms          | 0.0 per run                                                                      |
| Same-run layer false alarms           | 3.8 per run, against a bar of 5                                                  |
| 1.5x regression caught within 10 runs | 75%, bar 70%                                                                     |
| 1.5x caught in the run it lands       | 39%, bar 30%                                                                     |
| Attribution accuracy                  | folded into the above — a detection only counts if it names the commit within ±1 |
| Reproduction on real data             | passes, attributed to a single commit                                            |

Also built: the corpus, mainline commit ordering, per-case config digests, the
V1 paired control channel, the measurability screen, harness-change
attribution, and the shadow reconciliation model. All have checks wired into
`pnpm check`.

**One criterion is not met and was recorded rather than tuned around.** A
regression hotfixed within three or four days is fully recorded only 47% of the
time (12% at 1.5x). Section B4 of the acceptance criteria carries this, along
with the consequence: the faster a team fixes something, the less likely this
system remembers it happened. Two things follow — the ledger needs a manual
entry path, and no count from it may be presented as a complete incident
history.

## Blocked on the owner

**1. Triage of the 44-item list.** Delivered outside the repo (it names
teable-ee commits, see the disclosure rule below). Until the team marks which
are real and which are false positives there is no true false-positive rate,
and that number decides whether the ledger is worth building as a Teable table
or whether a weekly script suffices. This is the longest lead item and the only
one that can run in parallel with everything else.

**2. Pushing.** Local `main` is ahead of `origin/main`. Nothing has been pushed.

**3. Ledger shape**, once the triage number is in.

**4. Card mock**, to be reviewed before it is built.

## Blocked on me, in order

### 1. Confirm one clean shadow run in CI

Wiring, endpoint and token are all done. Three CI runs were needed to get here
and each found a different fault, all of them in the plumbing rather than in
the detection:

- `GET /api/base/{id}/query` — does not exist, answers 404. The real endpoint is
  `POST /api/base/{id}/sql-query` with the statement in the body.
- `403 base|query_data` — `TEABLE_PERF_LAB_TOKEN` could write to Performance
  Track but not query the base. The scope has been added; the refs query
  succeeded on the next run, which is how we know.
- The analysis hung for 34 minutes and was killed by the report job's own
  30-minute timeout, taking that job's last four steps with it — two acceptance
  gates and two artifact uploads. Cause: asynchronous `execFile` has no `input`
  option, silently ignores it, and leaves the child waiting on a pipe that never
  closes. Both ordering resolvers read stdin before doing anything.

What that last one changed, beyond the fix:

- **The shadow block now runs last in the job**, after both artifact uploads and
  both acceptance gates. That is the fix that matters: nothing the run depends
  on is queued behind a passenger any more.
- The step also carries `timeout-minutes: 20`, and the job's own budget went
  from 30 to 40 so that the job timeout is not what bounds the step.
  `continue-on-error` covers a step that fails and does nothing about one that
  never returns, and a job timeout cancels rather than skips.
- Each stage announces itself before starting, so a stuck run says where.
- `check:shadow-refresh-plumbing` runs the five stages end to end against two
  temporary git repositories and a stand-in Teable, under a watchdog. Nothing
  had ever executed that orchestration: every part had a passing check while
  the whole could not complete a single stage handoff.
- teable-ee was never checked out in the report job at all. The deepen step was
  written as if the `resolve_inputs` checkout carried over into a second job's
  workspace; it does not, and `continue-on-error` hid the exit 128.

### 2. The corpus is refetched in full every run — 325 requests, ~20 minutes

Measured end to end on a developer machine: **21m37s**, almost all of it the
corpus. The response cap is 50,000 characters, which turns 136,653 aggregated
rows into 325 pages at roughly two seconds each.

That two seconds is a fixed per-request cost, and this was measured rather than
assumed, because the obvious guess was wrong:

|                            |       |
| -------------------------- | ----- |
| `OFFSET 0`                 | 2.24s |
| `OFFSET 120000`            | 2.02s |
| narrowed to 8 cases        | 2.62s |
| `SELECT 1` through the CLI | 1.41s |

So deep pages are not expensive, and neither is the aggregation — paging
differently cannot help. Roughly 1.4s of each request is the `teable` CLI
starting a process, which CI does not pay: with a token it calls the API
directly, so the CI figure should be materially lower. **It has not been
measured yet.** The stage lines now printed by `run-shadow-analysis.mjs` give it
from the next successful run's log, and the step's 20-minute bound should come
down once they do.

The only real lever is asking fewer times. Two options, neither done:

- **Cache the corpus between runs**, the way the seen-set already is, and fetch
  only the newest rows. The history is append-only, so all but the last run's
  rows are known. Biggest win, most moving parts.
- **Fetch less of it.** The confirmed layer reads `analysisWindow = 80` recent
  points and the fast layer needs 40, so nothing consults the far history at
  run time. Cheap to do, but it narrows what the system can see, and the ledger
  may want the full span — so this is a decision about scope, not a tidy-up.

Worth settling before ten shadow runs turn 20 minutes into a standing cost.

### 3. Ten shadow runs

Calendar time, roughly a week at the current cadence. Needs one clean run first.

Note the cold start: the seen-set cache is empty, so the first successful run
reports its whole recent history, not what changed. A full local run on
2026-08-07 produced **11 same-run flags, 75 confirmed change points, 32 cases
not judgeable** across 755 series — and every one of those 75 is a first
sighting only because nothing had been recorded before. The second run is the
first whose confirmed count means "new". Two runs are needed before the output
says what it appears to say.

### 4. Ledger, card, retirement

All gated on the triage number and the shadow data. Section G of the acceptance
criteria will not accept retiring the old comparison until ten runs have been
reconciled and every case the new system dropped has been reviewed by hand.

## Disclosure rule — read before committing anything

**teable-perf-lab is public. teable-ee is not.** The standard, taken from what
the repository already carries:

- Bare teable-ee SHAs are fine. One is already in a test fixture, and every
  dispatch records a ref in public Actions metadata.
- **Commit subjects and descriptions of what a commit changed are not.**
  Findings name a commit and stop there; the description belongs in the
  internal issue.
- **A full mainline commit list is not**, even though each SHA individually
  would be. It describes teable-ee's size and cadence. This is why commit
  ordering resolves at runtime into the run's workspace and is never written
  back into the repo.

This was got wrong once: a triage document carrying 22 SHAs with their subject
lines was committed, and the history was rewritten to purge it before anything
was pushed. Check before committing, not after.

## A confirmed change point does not always mean V2 moved

The confirmed layer detects on the paired series, `log(v2) − log(v1)`, which is
what makes it immune to a slow runner. The cost is that a change in V1 alone
produces a change point that reads exactly like a V2 regression, because the
reported ratio is the ratio of that paired quantity.

Measured on the 75 change points from the 2026-08-07 local run, comparing the
eight points either side of each boundary:

|                                       |     |
| ------------------------------------- | --- |
| V2 moved, V1 flat — a real V2 change  | 34  |
| V1 moved, V2 flat — the control moved | 4   |
| both moved                            | 2   |
| shift below the 1.25x classifier bar  | 33  |
| no V1 series to compare against       | 2   |

So roughly one in ten of the ones large enough to classify is the control
channel moving, not V2. `record-read/50k-50fields-sort-text-ascending` at
`1dd78a15` is the clearest: reported 0.51x, and V2 went 1814ms to 1629ms — flat
— while V1 went 3683ms to 7316ms.

Two consequences. **Triage has to be told this**, or four of the items on the
list get chased into V2 and nothing is found there. And **the output should
carry which engine moved**, so nobody has to work it out by hand. The second is
not built; it needs both medians on each side attached to every change point,
which the detector already has and simply does not report.

## Findings this produced along the way

Two unfixed production regressions, both found while validating rather than
while looking:

- `a7c04bf9` — record-read, filed as an internal issue (`receeJXDRNoh7qQcy3o`)
  claiming 2.16x and 2.76x. **The 2026-08-07 run contradicts this and the issue
  has not been corrected yet.** On the full corpus, the only confirmed change
  point at `a7c04bf9` is `record-read/50k-50fields-sort-text-ascending`, and it
  is an improvement, not a regression: V2 goes 6301ms to 1593ms at mainline
  position 2600, while V1 stays near 8000ms. The large V2 regression on that
  case is a different commit, `a4c04008`, at position 2698 — 1680ms to 7562ms.
  Needs a decision on what to write back to the issue; this would be its second
  correction, after the retracted 3.59x headline below.
- `b636d744b4` — five foreign-key fanout cases, 1.4x to 2.5x, attribution exact
  to the single commit, was two days old when found. Heads the triage list; not
  filed separately yet.

The first issue was filed with a claim that had to be retracted afterwards: a
"3.59x" headline drawn from the noisiest series in the whole corpus, which moves
1.90x between adjacent runs of identical code. That is what the measurability
screen now exists to prevent, and it is the reason the screen runs before
detection rather than filtering findings after.
