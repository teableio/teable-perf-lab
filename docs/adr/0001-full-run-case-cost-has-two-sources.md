# ADR 0001: Full-run case cost has two sources, and that is not a bug to "fix"

- Status: Accepted
- Date: 2026-07-29

## Context

"How expensive is this case to cold-seed?" is answered by two tables that both
feed `scripts/run-plan.mjs`:

| table                                                                                  | entries | provenance              |
| -------------------------------------------------------------------------------------- | ------- | ----------------------- |
| `FULL_RUN_SEED_WEIGHT_MS_BY_CASE_ID` (`scripts/full-run-shard-model.mjs`)              | 35      | Actions run 29738811090 |
| `FULL_RUN_EXECUTE_CALIBRATION_BY_CASE_ID` (`scripts/full-run-execute-calibration.mjs`) | 316     | Actions run 29979412537 |

Both are live. The older table builds the scalar baseline shard plan, which is
the fallback when the stage-aware simulation is absent **and** the baseline the
stage-aware planner compares against to reject a slower replacement plan.

They disagree. Of 32 overlapping case ids, 7 differ by more than 2x, the worst
by 38x (`lookup/customer-update-user-first-name-only-create-order-4k-depth5`:
28,521 ms vs 742.71 ms), and 3 ids in the older table are absent from the newer
one.

An architecture review flagged this as a possible correctness defect. It is
worth recording what the divergence actually is, so the next review does not
re-open it as an unknown.

## Investigation

The older table's own comment offers an explanation: shared-fixture siblings
stay in one bundle, so a physical fixture's build cost is attributed to whichever
case creates it. If that is the whole story, the divergence should disappear when
the numbers are summed per affinity group.

Summing per affinity group (legacy `FULL_RUN_FIXTURE_AFFINITIES` plus the newer
per-case `seedAffinity`):

| case                                                                 | per-case | per-group                                                           | verdict       |
| -------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- | ------------- |
| `lookup/customer-update-user-first-name-only-create-order-4k-depth5` | 38.4x    | `customer-upsert/4k-depth5`, 5 members: 98,964 vs 63,931 = **1.5x** | attribution   |
| `lookup/conditional-group-text-fanout10-10k`                         | 2.2x     | legacy group 1, 11 members: 24,598 vs 14,628 = **1.7x**             | attribution   |
| `field-convert/formula-expression-update-4k-depth5-cascade`          | 2.2x     | `computed-chain/4k-depth5`, 8 members: 49,790 vs 74,129 = **0.7x**  | attribution   |
| `lookup/foreign-first-name-update-1of40-fanout100-4k`                | 2.1x     | same group as above                                                 | attribution   |
| `field-convert/10k-text-to-date-mixed`                               | 4.6x     | **no affinity group**                                               | genuine drift |
| `field-convert/10k-text-to-link`                                     | 4.1x     | **no affinity group**                                               | genuine drift |
| `field-duplicate/conditional-lookup-10k`                             | 2.2x     | **no affinity group**                                               | genuine drift |

The headline 38x is an artefact of attribution: the cost moved to other members
of the same physical fixture, and the group total only differs by 1.5x.

Three cases have no shared fixture, so there is nothing to redistribute to.
Their 2.2x-4.6x difference is real measurement drift between the two runs. The
older table is genuinely older, and nothing checks that the two agree.

## Decision

Keep both tables. Do not reconcile them by editing numbers, and do not treat the
per-case divergence as evidence of a defect.

Specifically:

- The 38x figure is **not** a correctness problem. Any future analysis that
  compares these tables must compare per affinity group, not per case.
- The older table **is** stale by roughly 2x-4x on the three cases that have no
  shared fixture. This degrades plan quality; it does not produce wrong results.

## Consequences

The stale baseline means shard packing is decided partly on old numbers, and the
"reject a slower replacement plan" comparison inherits that. This is a quality
cost, not a correctness cost, so it is scheduled work rather than a fix.

Collapsing to a single source is the obvious next step and is tractable: the
newer table already carries `coldSeedMs` for all 316 cases, which makes the
35-entry table redundant in principle. It was not done here because:

- deriving the scalar baseline from the newer calibration changes shard packing,
  which changes the selected plan, so `scripts/check-run-plan.mjs` fails by
  design and its pinned expectations have to be regenerated;
- whether the new packing is actually better can only be answered by a full run
  comparing wall time against the current plan.

That is a bounded experiment with a CI budget attached, not a refactor to slip
into an unrelated change.

Related observation from run 30423990844: the trace stage is predicted at
60,000 ms and observed at 327 ms, a 183x over-prediction. Same root cause — cost
calibration has no owner and no mechanism notices when it drifts.
