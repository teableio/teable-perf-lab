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

### 1. The perf token needs `base|query_data` — blocked on someone with rights

The shadow analysis is wired into the workflow and runs, but every SQL query it
makes is refused:

```
403 not allowed to operate base|query_data on bselS3I2MeVI6RJhS4g
```

`TEABLE_PERF_LAB_TOKEN` can write to Performance Track — it has been recording
measurements all along — but cannot run a SQL query against the base. The new
analysis reads its corpus through `sql-query`, so it cannot start until that
scope is added to the token.

Nothing else about the wiring is outstanding. Two CI runs found and fixed a
wrong endpoint (`GET .../query` against the real `POST .../sql-query`); this is
what is left.

Until then every run records that it produced nothing, in the job summary and
as a workflow warning, so the shadow does not accumulate ten empty runs that
look like ten quiet ones.

### 2. Wire it into the workflow

Once it runs: one step in `.github/workflows/teable-ee-e2e-perf.yml` after the
report stage, publishing the result as an artifact. It must never fail the run —
`run-shadow-analysis.mjs` already swallows its own errors for this reason.

### 3. Ten shadow runs

Calendar time, roughly a week at the current cadence. Cannot start until the
above works.

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

## Findings this produced along the way

Two unfixed production regressions, both found while validating rather than
while looking:

- `a7c04bf9` — record-read, 2.16x and 2.76x on two cases, filed as an internal
  issue (`receeJXDRNoh7qQcy3o`), was 8 days old when found.
- `b636d744b4` — five foreign-key fanout cases, 1.4x to 2.5x, attribution exact
  to the single commit, was two days old when found. Heads the triage list; not
  filed separately yet.

The first issue was filed with a claim that had to be retracted afterwards: a
"3.59x" headline drawn from the noisiest series in the whole corpus, which moves
1.90x between adjacent runs of identical code. That is what the measurability
screen now exists to prevent, and it is the reason the screen runs before
detection rather than filtering findings after.
