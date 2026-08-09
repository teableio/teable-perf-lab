# Perf alerting: where this stands and what is left

Written 2026-08-07 to be picked up cold. Everything needed to resume is here or
linked from here.

**Where it stands:** the shadow analysis is merged and runs on every dispatch,
verified end to end in CI. Nothing it finds is shown to anyone yet. The next
step is calendar time — ten full runs — and it is the owner who starts those, by
dispatching full runs as normal. Then sections 1 and 2 below, then the ledger.

**If you are the next agent on this:** sections 1 and 2 are history, kept
because the faults in them are the ones this wiring keeps producing. Section 2's
fix is in — the same-run layer now judges this run's own measurements, so
section 4's ten runs mean what they say. Section 3 is the one thing still open
on this side, and it is a known cost with a decision attached rather than a
defect — though acceptance F3 asks for the incremental read by name, so it is
not indefinitely deferrable either. Everything numbered below was measured — if
you change a number, measure it again rather than reasoning about it. Most of
those five faults looked correct right up until someone read the raw values, and
two of them produced a green tick.

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

**1. ~~Triage of the 44-item list.~~ Dropped 2026-08-10 — do not go looking for
it.** The list was delivered outside the repo (it names teable-ee commits, see
the disclosure rule below), that document was not kept, and the owner chose to
judge what the nightly runs surface from now on rather than reconstruct a
backfill nobody has read. Nothing is blocked by this: the false-positive rate it
was meant to produce now comes from live runs instead, later and on better
evidence.

One thing to know before anyone tries to revive it. The seen-set grows
monotonically and already holds the cold-start batch plus everything found on
2026-08-08 and 08-09, so none of those change points will resurface on their
own — what the nightly runs report is what is _new_. Reviving the historical
list means clearing the seen-set deliberately, which also costs the next run its
meaning, since a cleared set reports the whole recent history as fresh again.

**2. Ledger shape**, once enough nightly runs have been judged to give a
false-positive rate.

**3. Card mock**, to be reviewed before it is built.

Merged to `main` at `fab8642b` on 2026-08-07, after run 31192079501 read the
whole history and 31193504224 confirmed the seen-set carries between runs. The
shadow now runs on every dispatch and reports into the job summary; nothing it
produces reaches the Feishu card.

## Blocked on me, in order

### 1. One clean shadow run in CI — done

Run 31192079501 on `perf/shadow-analysis-ci`, 8m30s, reading the whole history:

|                    |                                                                |
| ------------------ | -------------------------------------------------------------- |
| teable-ee mainline | 2707 commits, 518 of 573 refs positioned                       |
| perf-lab digests   | 280 of 280 commits, 402 cases, 157 changed workload            |
| corpus             | 136,659 rows → 755 series, median 152 comparable points        |
| result             | 6 same-run flags, 68 confirmed change points, 31 not judgeable |

Close to the local run of the same day (11 / 75 / 32); the difference is two
days of new rows and a different newest run under the fast layer's nose.

Five CI runs were needed to get here and each found a different fault, every
one of them in the plumbing rather than in the detection:

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
  tell apart.** `actions/checkout` clones shallow, and a later fetch with
  `--filter=tree:0` stops at the shallow boundary rather than deepening past
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
- The step also carries `timeout-minutes: 15`, against a measured 8m30s, and the
  job's own budget went from 30 to 40 so that the job timeout is not what bounds
  the step. `continue-on-error` covers a step that fails and does nothing about
  one that never returns, and a job timeout cancels rather than skips.
- **The script exits non-zero when it fails**, which it used to swallow. Now
  that the step carries `continue-on-error` and runs last, a non-zero exit
  cannot cost the run anything — and the seen-set save is gated on this step's
  `outcome`, so swallowing the error held that gate permanently open. A run that
  refused to produce a result was still writing state back and still reading as
  successful in the Actions UI.
- Each stage announces itself before starting, so a stuck run says where.
- `check:shadow-refresh-plumbing` runs the five stages end to end against two
  temporary git repositories and a stand-in Teable, under a watchdog. Nothing
  had ever executed that orchestration: every part had a passing check while
  the whole could not complete a single stage handoff.
- teable-ee was never checked out in the report job at all. The deepen step was
  written as if the `resolve_inputs` checkout carried over into a second job's
  workspace; it does not, and `continue-on-error` hid the exit 128.

### 2. The same-run layer judges the newest point in the corpus, not this run's — fixed

Verified on runs 31192079501 and 31193504224: both flagged the same six cases at
byte-identical ratios — 4.23x, 2.061x, 1.801x, 1.536x, 1.475x, 1.402x — and both
reported `judged: 283`.

That is not stability, it is the same data twice. Both were single-case
dispatches of `smoke/auth-user`, so each added exactly two rows to the corpus
(one per engine) and left the other 282 cases untouched. `analyse` builds
`fastCases` from every measurable V2 series and takes `values[values.length - 1]`
as the point under test, so for any case this run did not measure that point
comes from whenever it was last measured — here, days-old rows from the previous
full run, re-judged and re-flagged as if they were new.

The real cadence is full runs, where every case is measured and the newest point
really is this run's, so this is mostly an artefact of cheap verification. Two
things still follow:

- **The ten reconciliation runs have to be full runs.** Ten single-case runs
  would re-report the same six flags ten times and the reconciliation would mean
  nothing.
- **A case the run did not measure should not be judged at all.** Done. The
  shadow step reads this run's payloads from `PERF_LAB_ARTIFACT_DIR` — v2,
  passing, positive, median across shards, the same three filters the corpus
  query applies — and `analyse` takes them as `measured`. A case not in that map
  is not judged; it is counted under `not-measured-this-run` in `fast.skipped`,
  and `fast.source` says which point was judged (`run` or `corpus-tail`) so the
  reconciliation counts cannot be read as the wrong thing later.

  The same change fixed a second fault that was not visible from the pair of
  runs above. The shadow runs _after_ the report has written this run's rows
  into Performance Track, so the corpus it rebuilds already contains the point
  being judged — and `checkLatest` reads its threshold off the history it is
  given. A large enough spike raises its own bar and comes back clean. History
  is now cut at the run's own mainline ordinal, so this run's rows are out of
  the distribution its threshold comes from. `check:shadow-analysis` holds both
  behaviours; the contamination case flags at 4x with the trim and reports
  nothing without it.

  Without `PERF_LAB_ARTIFACT_DIR` — a local analysis over the history, which has
  no run of its own — the old behaviour stands and the log says so.

  What this does not do is remove the fast layer's dependency on the corpus
  being rebuilt first. It still needs each case's history to have a threshold at
  all; only the point under test now comes from the run.

The confirmed layer does not have this problem — it is deduplicated by
`[[change-point-identity-model]]` and was clean across the pair: 68 new and 0
repeated on the first run, 0 new and 68 repeated on the second.

### 3. The corpus is refetched in full every run — 325 requests, ~4 minutes

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

**Decided 2026-08-10: neither, for now — and it is now a nightly cost.** With
the run scheduled every night, the corpus rebuild is about four minutes a night
rather than four minutes whenever someone remembers to dispatch. That is
accepted rather than fixed, because the shadow step runs last and behind
`continue-on-error`, so those four minutes cost the run nothing that it needs.

What settles it is the incremental read in acceptance F3, which asks for it by
name — "a run fetches only its own rows, one page, one query". Do that before
the ledger, not in the same change as the reconciliation fix: the watermark has
to survive a commit being re-measured by a later run, which is a correctness
question of its own and does not belong in a change whose point is that a zero
must not be able to lie.

### 4. Ten shadow runs

**The volume is already there and none of it counts.** Between 2026-08-08 and
2026-08-09, 25 full runs carried the shadow step and 23 produced a usable
artifact — all dispatched by hand, more than twice the ten G1 asks for. Every
one of those 23 recorded `reconciliation.counts.old: 0`, and not because the old
gate was quiet: `RELEASE_COMPARISON_PATH` pointed at `release-baseline.json`,
which carries the released build's per-case values and no `regressions` key at
all. `comparison.regressions ?? []` read that as an empty list, the file parsed
so nothing threw, and 23 runs reconciled the new system against silence. Fixed
by writing the old gate's verdict to `release-comparison.json` in a step of its
own (`resolve-release-comparison.mjs`) — but the 23 cannot be recovered, so the
ten start from the first run that carries the fix.

Two things this cost, worth keeping:

- **`continue-on-error` rewrites a step's `conclusion` to success.** Whether a
  shadow run happened can only be read from whether its artifact exists; the
  jobs API will say success for a run that was killed at 30 minutes with no
  output. Two runs on 08-07 look exactly like the other 23 through that lens.
- **A zero from an unasked question looks like agreement.** The same shape as
  the shallow clone, a third time. The run ledger now refuses to count a run
  whose `oldGate.available` is not true, with the reason attached.

Calendar time, roughly a week at the current cadence. Needs one clean run first.

Note the cold start: the seen-set cache is empty, so the first successful run
reports its whole recent history, not what changed. A full local run on
2026-08-07 produced **11 same-run flags, 75 confirmed change points, 32 cases
not judgeable** across 755 series — and every one of those 75 is a first
sighting only because nothing had been recorded before. The second run is the
first whose confirmed count means "new". Two runs are needed before the output
says what it appears to say.

**The runs now accumulate on their own.** `accumulate-shadow-runs.mjs` appends
each run to `shadow-runs.json`, carried between runs in the same cache entry as
the seen-set and uploaded as an artifact so a cache eviction over a week of
calendar time does not lose the count. Each run prints where G1 and G2 stand
into the job summary, so "are we at run 3 or run 7" is answered by the system
rather than by someone collecting artifacts. Before this, `accumulate()` in
`shadow-comparison-model.mjs` was called by nothing but its own check.

What counts toward G1, and what does not:

- **A full run only.** Taken from the dispatch (`case_filter_is_all`), not
  inferred from how many cases were measured, so a full run with a dead shard
  reads as a full run that failed rather than as a single-case dispatch.
- **Judging this run's own measurements only.** A run that fell back to the
  corpus tail is reconciling the old gate against days-old data. It is recorded
  and reported as `judged-the-corpus-tail`, not counted.
- **The analysis has to have succeeded.** The step is gated on the shadow step's
  `outcome`, like the seen-set save.

**Two readings from the 23 dead runs that do not match the backtest**, both
worth having in hand before the ten start, neither verified here:

- The same-run layer averaged 4.5 flags per run against the backtest's 3.8 —
  inside the band — but `record-delete/delete-stream-1k` and
  `record-create/mixed-1k-20fields-bulk-create` flagged in **23 runs out of 23**
  between them, close to half the average. A case that flags every single run is
  not a detection; either the measurability screen should be rejecting it or its
  threshold is being read off a history it does not belong to.
- The confirmed layer produced **7.7 fresh change points per run** across the 22
  post-cold-start runs (169 total, 122 distinct cases), against a backtest that
  measured 0.0 false alarms per run. A run advances the mainline by about one
  commit and cannot generate that many genuine change points. The unverified
  hypothesis is the ±1 boundary jitter recorded further down this document: the
  corpus grows, the split lands one commit over, `changePointKey` changes with
  it, and the seen-set reports the same change point again as new. If that is
  it, the identity needs to tolerate a one-position move — which is a change to
  the ledger's identity scheme and has to be made before the ledger exists, not
  after.

**The ten now run themselves.** A nightly schedule at 18:00 UTC — 02:00 Beijing,
after the working day's commits — dispatches a full run on the default branch.
Twenty-five hand-dispatched runs produced the last round of evidence and two of
them died on a timeout with nobody watching; a validation that depends on
someone pressing a button is not a validation. `inputs` is null on a scheduled
run, so every input the workflow reads carries its dispatch default explicitly
for that path, including the concurrency key — without it a scheduled full run
would take the per-ref single-case key, which is the one arrangement that lets
two full runs overlap and measure each other's noise. The cadence is sized for
the validation window and should be reconsidered the moment G1 is met.

**Dispatch anything manual from `main` too.** Actions caches are scoped to the branch that
wrote them plus the default branch, so a run on a feature branch cannot read a
ledger — or a seen-set — written by a run on another one. Ten runs spread across
branches would each start from an empty ledger and report one qualifying run
apiece, and the seen-set would re-announce the whole recent history every time.
This is not new behaviour and it has never been said out loud anywhere.

G2 is computed as flags per run against the backtest's 3.8, pinned as a constant
rather than recalled from this document, with the 2x band read in both
directions. One honest limit is built into the verdicts: what is measured is the
_flag_ rate, and a flag is not a known false alarm until someone looks. Inside
the band that bounds the false-alarm rate from above and settles G2; above the
band it does not fail G2 by itself, because the excess may be real findings —
that verdict is `above-band-needs-triage` and hands the question to G3. Below
the band is `below-band-check-inputs`: a well-formed artifact reporting almost
nothing is what the shallow clone produced twice, and it must never read as
"quieter than promised".

### 5. Ledger, card, retirement

All gated on the shadow data, and on a false-positive rate now drawn from the
nightly runs rather than from the dropped 44-item list. Section G of the
acceptance criteria will not accept retiring the old comparison until ten runs
have been reconciled and every case the new system dropped has been reviewed by
hand.

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
carry which engine moved**, so nobody has to work it out by hand.

The second is now built. Every change point carries `mover` — `v2`, `v1`,
`both`, `below-bar`, `no-control` or `unknown` — with `v2Ratio`, `v1Ratio` and
both medians either side, taken over the same eight points and the same 1.25x
bar the table above was measured with. The job summary counts the movers beside
the change point count, so a run whose findings are mostly control-channel says
so without anyone opening the artifact.
`change-point-attribution-model.mjs` holds it; the classifier deliberately
answers `below-bar` rather than naming an engine when neither moved 1.25x, which
is a third of them.

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
neighbouring commit explicitly rather than leaving the reader to know.

The second is now built: every change point carries `alsoPossible`, the measured
commits sitting one mainline position either side of the one it names, and
`unmeasuredBetween`, the count of mainline commits between the last measurement
before the boundary and the one after. The second number is the one to read when
it is large — a hundred unmeasured commits in the gap means the named commit
ends a range rather than answering the question, and no ±1 phrasing covers that.
Telling triage about the tolerance is still owed. With the 44-item list dropped
it now belongs wherever the nightly output is read — the card, or the ledger
once it exists — rather than in code.

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
