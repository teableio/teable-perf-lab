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

**2. Merging.** The work is on `perf/shadow-analysis-ci`, pushed, with `main`
untouched. It merges once a CI run reports a corpus it actually read.

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
- **The run after that succeeded and reported nothing, and the two are hard to
  tell apart.** `actions/checkout` clones shallow, and `git fetch
--filter=tree:0` fetches to the shallow boundary rather than deepening past
  it. So the teable-ee mainline read one commit long, 572 of 573 refs came back
  `offMainline`, 277 of 278 perf-lab commits had no tree to digest, and every
  series was cut to a single point. The step exited 0 in 5m56s, wrote a
  well-formed artifact, and put `0 flagged, 0 confirmed` in the job summary —
  which is exactly what a quiet, healthy run looks like.

  teable-ee takes `fetch-depth: 0` with `filter: tree:0` on the checkout, since
  it only ever reads commit objects. perf-lab is unshallowed in a step of its
  own with `--filter=blob:none`, so the case files come down and the rest of the
  history's contents stay on the server, and only the shadow pays for it. Test
  for the shallow state with `rev-parse --is-shallow-repository`, not by looking
  for a `shallow` file — `rev-parse --git-dir` answers relative to the
  repository, so that test reads the wrong directory and silently skips.

  And `assertUsable` in `run-shadow-analysis.mjs` now
  refuses to write a result at all when under half the refs position or the
  median series is shorter than the 30 points the confirmed layer needs. A zero
  is a claim; it should only be made about a history that was actually read.

What that last one changed, beyond the fix:

- **The shadow block now runs last in the job**, after both artifact uploads and
  both acceptance gates. That is the fix that matters: nothing the run depends
  on is queued behind a passenger any more.
- The step also carries `timeout-minutes: 12`, against a measured 5m56s, and the
  job's own budget went from 30 to 40 so that the job timeout is not what bounds
  the step. `continue-on-error` covers a step that fails and does nothing about
  one that never returns, and a job timeout cancels rather than skips.
- Each stage announces itself before starting, so a stuck run says where.
- `check:shadow-refresh-plumbing` runs the five stages end to end against two
  temporary git repositories and a stand-in Teable, under a watchdog. Nothing
  had ever executed that orchestration: every part had a passing check while
  the whole could not complete a single stage handoff.
- teable-ee was never checked out in the report job at all. The deepen step was
  written as if the `resolve_inputs` checkout carried over into a second job's
  workspace; it does not, and `continue-on-error` hid the exit 128.

### 2. The corpus is refetched in full every run — 325 requests, ~4 minutes

Measured in CI: **5m56s** for the whole step, of which **3m52s** is the corpus.
The same work is 21m37s on a developer machine — the difference is the `teable`
CLI starting a process per page, which CI does not pay because with a token it
calls the API directly. The step's bound is set at 12 minutes against that 5m56s.

The response cap is 50,000 characters, which turns 136,655 aggregated rows into
325 pages. What each of those costs is per-request overhead rather than the
aggregation, and that was measured rather than assumed, because the obvious
guess was wrong:

|                            |       |
| -------------------------- | ----- |
| `OFFSET 0`                 | 2.24s |
| `OFFSET 120000`            | 2.02s |
| narrowed to 8 cases        | 2.62s |
| `SELECT 1` through the CLI | 1.41s |

So deep pages are not expensive, and neither is the aggregation — paging
differently cannot help. The only real lever is asking fewer times. Two options,
neither done:

- **Cache the corpus between runs**, the way the seen-set already is, and fetch
  only the newest rows. The history is append-only, so all but the last run's
  rows are known. Biggest win, most moving parts.
- **Fetch less of it.** The confirmed layer reads `analysisWindow = 80` recent
  points and the fast layer needs 40, so nothing consults the far history at
  run time. Cheap to do, but it narrows what the system can see, and the ledger
  may want the full span — so this is a decision about scope, not a tidy-up.

Worth settling before ten shadow runs turn six minutes a run into a standing cost.

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

## The commit named is sometimes the one next to the culprit

Acceptance section B counts a detection as correct if it names the commit within
±1, and that tolerance is real rather than theoretical. On
`record-read/50k-50fields-group-number-low-cardinality` the measurements go
2802ms at mainline position 2599 and 6796ms at 2600, so the commit that did it
is the one at 2600 — `a7c04bf9`. The change point reports position 2601, and
therefore names `736df78f`, an innocent neighbour.

The likely reason is visible in the same window: V1 at 2599 reads 6938ms against
about 5200ms either side, and the detector works on `log(v2) − log(v1)`, so one
noisy control point moves where the split lands.

Nothing is wrong by the stated criteria — this is inside the tolerance that was
signed off. But a SHA in an alert does not read as "this or its neighbour", and
whoever triages will open exactly the commit named. Two things follow: **the
triage list has to say the boundary is ±1**, and the output should carry the
neighbouring commit explicitly rather than leaving the reader to know. Neither
is done.

## Findings this produced along the way

Two production regressions, both found while validating rather than while
looking:

- `a7c04bf9` — record-read, filed as an internal issue (`receeJXDRNoh7qQcy3o`),
  was 8 days old when found. **Since fixed**, by `a4c04008`. On
  `record-read/50k-50fields-group-number-low-cardinality` V2 goes 2802ms to
  6796ms at mainline position 2600, holds there for about a hundred commits,
  and returns to 3094ms at position 2698 — 2452ms to 2768ms since, which is
  where it was before. The report is closed by the data, not by inspection.
- `b636d744b4` — five foreign-key fanout cases, 1.4x to 2.5x, attribution exact
  to the single commit, was two days old when found. Heads the triage list; not
  filed separately yet.

One commit is rarely one story. The same `a7c04bf9` that cost the grouping case
2.4x made `record-read/50k-50fields-sort-text-ascending` four times faster
(6301ms to 1593ms), and the `a4c04008` that fixed the grouping case regressed
the sorting one (1680ms to 7562ms, ~3286ms and falling since). Reading one case
and generalising gets the direction exactly backwards — which happened here,
during this write-up, before the second case was pulled.

The first issue was filed with a claim that had to be retracted afterwards: a
"3.59x" headline drawn from the noisiest series in the whole corpus, which moves
1.90x between adjacent runs of identical code. That is what the measurability
screen now exists to prevent, and it is the reason the screen runs before
detection rather than filtering findings after.
