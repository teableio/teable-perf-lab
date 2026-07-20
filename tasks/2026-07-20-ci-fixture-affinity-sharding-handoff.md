# CI fixture-affinity sharding handoff

Date: 2026-07-20

Branch: `codex/ci-four-way-sharding`

## Goal

Reduce full `case_filter=all` GitHub Actions wall time without rebuilding the
same physical seed fixture in multiple shards. Cases proven to emit the same
runner `seedHash` must remain an indivisible bundle.

## Committed baseline

- `bf3bb4d ci: shard full perf runs four ways`
- `20ba365 fix: isolate sharded perf cases`
- `f4c665d ci: shard seed fixtures by affinity`

The first two commits produced a successful execute-sharded full run:

- Actions run: <https://github.com/teableio/teable-perf-lab/actions/runs/29734699142>
- 512 results: 506 pass, 6 skipped, 0 fail.
- Warm/restore-key seed: 6m59s.
- Longest execute shards: V1 18m43s, V2 sync 16m58s, hybrid 4m05s.
- Report: 13m19s.
- Active workflow wall time: 39m16s; dispatch-to-finish: 46m53s including
  runner queue time.

`f4c665d` added four matching seed shards and explicit fixture affinities. It
passed `pnpm check` before push.

## Current four-shard experiment

Actions run: <https://github.com/teableio/teable-perf-lab/actions/runs/29738811090>

This run uses `f4c665d`, so it tests the committed four-shard implementation,
not the adaptive seven-shard work below. Status captured at 2026-07-20 12:06
UTC:

- Report job was still running; the workflow had not completed.
- Cold seed shard wall times were 11m27s, 12m45s, 16m03s, and 17m53s.
- The old unsharded cold seed baseline was 64m07s in run `29725955367`.
- `v2-hybrid-computed-shard-4-of-4` failed because
  `lookup/dual-link-computed-repoint-2k` recorded
  `lookupPropagationMs=120399.26ms` against a 40,000ms threshold. The preceding
  successful full run recorded about 15.0s, and the case is first in its shard,
  so no threshold change has been made.
- `v1-shard-2-of-4` also concluded failure. Its error has not been inspected.
- All other execute shards completed successfully.

Do not treat this run as accepted until both failures are inspected and a
rerun/next run succeeds.

## Evidence behind affinity and weight modeling

The prior successful full-run artifacts contained 424 seeded results and 138
distinct `seedHash` values. Twelve multi-case physical fixture groups were
identified, including the 22-case `record-read/10k-50fields` group and the
conditional-query, field-create, record-create, record-update, and search-index
families now listed in `scripts/full-run-shard-model.mjs`.

The four-shard cold run showed why case-count balancing is insufficient:

- `record-read/50k-50fields-50x1k-pages` alone used 440,282ms in seed mode.
- `search/search-index-off-50k-20search-fields` used 368,802ms.
- The 4-way case counts were exactly 64/64/64/64, but seed wall time still
  ranged from 11m27s to 17m53s.

Historical execute projection showed diminishing returns at eight shards:

- 4 shards: projected longest V1 about 17.5m.
- 6 shards: about 12.9m.
- 7 shards: about 11.1m.
- 8 shards: about 11.0m.

## Uncommitted adaptive design included with this handoff commit

The working change removes the fixed four-shard count:

- shard count is derived from catalog size at roughly 40 cases per shard;
- shard count is capped at 8; the current 256-case catalog resolves to 7;
- shared `seedHash` fixture bundles remain indivisible;
- material cold-seed outliers from run `29738811090` are calibrated in
  `scripts/full-run-shard-model.mjs`;
- each case also receives a 10-second execute/trace overhead weight;
- sync and hybrid bundles are packed independently with weighted LPT, then
  paired by weight into one global seed/V1/V2 mapping.

The generated current plan has these case counts:

- seed and V1: 40, 25, 47, 19, 38, 40, 47;
- V2 sync: 38, 23, 44, 17, 35, 37, 45;
- V2 hybrid: 2, 2, 3, 2, 3, 3, 2.

`pnpm check:run-plan` passes. A complete `pnpm check` has **not** been run after
the adaptive seven-shard edits.

## Resume checklist

1. Read the final state of Actions run `29738811090` and inspect the
   `v1-shard-2-of-4` failure before changing code or thresholds.
2. Review the calibrated outlier map and weighted packing in
   `scripts/full-run-shard-model.mjs`.
3. Run `pnpm check`.
4. Push the handoff commit only if it is not already on the remote.
5. Trigger a full Actions run for the adaptive plan. Its new `shard-N-of-7`
   cache keys make the first run a real cold-seed validation.
6. Accept only after result coverage, thresholds, report, and trace manifests
   are verified. Compare longest seed/execute stage and total wall time against
   both `29738811090` and `29734699142`.
