# Autonomous Perf Cases — Batch 01

Status: approved by standing user authorization on 2026-07-17. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies: proceed with the assumptions below, validate them through local V1/V2
runs, and revise or drop any case that does not produce a stable, meaningful
comparison.

## Batch Goal

Add ten high-value cases that fill real coverage or scale gaps without repeating
the already-dense conditional lookup/rollup matrix. Every case must:

- keep deterministic seed and execute phases separate;
- measure only the product operation (plus readiness when the case promises
  computed/read state), not fixture construction;
- assert the requested V1/V2 route when the endpoint is canary-routed;
- verify the promised final state through samples plus a full scan or the
  operation-family equivalent;
- pass `pnpm check`, local V1 and V2 execution, and artifact/trace inspection.

## Case 1: `selection-clear/flat-10k-20fields-cell-clear-stream`

- **Goal**: catch nonlinear regressions when the grid clears all cells in a
  10,000-row, 20-field mixed table.
- **Runner**: `selection-clear` (reuse; widen the metric-name type only).
- **Seed Phase**: reuse the existing deterministic 20-field selection-clear
  layout at 10,000 rows, seeded in 1,000-row batches.
- **Execute Phase**: V1 uses the range clear stream and V2 uses the by-id clear
  stream, matching each engine's grid behavior; read through the final SSE
  `done` event.
- **Primary Metric**: `clear10kMs`, initial `maxMs: 60_000`.
- **Verification**: stream count is 10,000; all 10,000 rows remain; a paged full
  scan proves all projected cells are empty.
- **Open Assumptions**: 10k is large enough to expose scaling while remaining a
  stable dual-engine workload; tighten the threshold after local/CI history.

## Case 2: `record-delete/delete-stream-30k`

- **Goal**: extend the established 1k/10k delete-stream curve to a customer-like
  30,000-row selection.
- **Runner**: `record-delete-stream` (reuse; add the 30k metric literal).
- **Seed Phase**: deterministic 30,000-row mixed table, 1,000-row seed batches.
- **Execute Phase**: delete all rows through the same UI behavior on both
  engines and consume the stream to completion.
- **Primary Metric**: `deleteStream30kMs`, initial `maxMs: 120_000`.
- **Verification**: route headers match the engine, the `done` event reports
  30,000 deleted rows, and the final table count is zero.
- **Open Assumptions**: 30k stays below the known unstable inline-create shape
  and should scale from the already-green 10k delete-stream workload.

## Case 3: `table-delete/30k-20f-link-detach`

- **Goal**: expose the row-dependent V1 `detachLink` cost when deleting a table
  still referenced by 30,000 populated host link cells, while preserving the V2
  soft-delete comparison.
- **Runner**: `table-delete-link` (reuse).
- **Seed Phase**: one 30,000-row mixed host table plus 1,000 foreign rows and a
  deterministic populated link field. Batched host inserts use V2 during seed
  mode because seed construction is not part of the measured engine comparison;
  the V1 seed route exceeded the 30-minute case budget even for one fixture.
- **Execute Phase**: archive the referenced table once. The existing 10k case
  keeps three-sample p95 coverage; this 30k scale canary uses one fixture after
  repeated cold CI fixtures exceeded the 30-minute case budget. Its sample
  count is fixed at one instead of inheriting the workflow-wide sample override.
- **Primary Metric**: `deleteTableDetachLink30kMs`, initial `maxMs: 30_000`.
- **Verification**: deleted table is in trash; surviving table remains readable;
  the engine-specific link behavior matches the existing runner contract.
- **Open Assumptions**: 30k should strengthen the known O(rowCount) V1 signal
  without using the larger duplicate-table shapes that previously hit 402. The
  V2-built seed must remain semantically identical under the existing full-row,
  link-sample, trash-state, and engine-routing verification.

## Case 4: `formula/50k-calc`

- **Goal**: measure formula-field creation and full readiness on 50,000 rows,
  extending the stable 10k baseline.
- **Runner**: `formula-table` (reuse).
- **Seed Phase**: 50,000 deterministic numeric rows in 1,000-row batches.
- **Execute Phase**: create `({A} * {B}) + {C}` after seed readiness and wait
  until the complete table is readable.
- **Primary Metric**: `formulaFullReadyMs`, initial `maxMs: 30_000`.
- **Verification**: known samples plus a full 50,000-row paged scan match locally
  computed expected values.
- **Open Assumptions**: the existing 50k search fixtures prove this row scale is
  supportable; formula convergence, not seed time, remains the primary signal.

## Case 5: `record-read/50k-50fields-50x1k-pages`

- **Goal**: measure a complete 50,000-row read with 50 projected fields,
  including 20 lookups and five formulas.
- **Runner**: `record-read` (reuse; add a scale-specific primary metric literal).
- **Seed Phase**: deterministic 50k source/host fixture using the existing
  lookup/formula topology and 1,000-row batches.
- **Execute Phase**: read fifty consecutive 1,000-row pages after computed seed
  readiness.
- **Primary Metric**: `getRecords50kPagedScanMs`, initial `maxMs: 60_000`.
- **Verification**: page bounds, total scanned rows, sample values, and the
  existing full-read workload model all agree at 50,000 rows.
- **Open Assumptions**: keep page size fixed so the new case isolates total row
  scale rather than changing request size.

## Case 6: `record-update/single-foreign-first-name-update-1of40-fanout100-4k`

- **Goal**: cover the distinct `updateRecord` canary route while measuring one
  realistic text edit propagating through 100 Orders and 10 Purchases.
- **Runner**: `computed-chain-mutation` (extend with
  `recordWriteMode: "single"`; default existing cases to `"bulk"`).
- **Seed Phase**: reuse the deterministic 40-User / 4,000-Order / 400-Purchase
  depth-five graph.
- **Execute Phase**: call `PATCH /record/:recordId` for only User 20's
  `first_name`, then wait until the first affected Order exposes all new lookup
  and formula values.
- **Primary Metric**: `firstOrderReadyTotalMs`, initial `maxMs: 15_000`.
- **Verification**: all 100 affected Orders and 10 Purchases converge; all
  controls remain unchanged; routing asserts feature `updateRecord`.
- **Open Assumptions**: keep the same topology and threshold as the bulk-route
  sibling so route choice is the only workload delta.

## Case 7: `record-update/single-foreign-select-update-1of40-fanout100-4k`

- **Goal**: cover single-record select serialization and propagation through the
  same deep graph without conflating it with text-cell behavior.
- **Runner**: `computed-chain-mutation` (reuse the Case 6 extension).
- **Seed Phase**: identical 40/4k/400 fixture.
- **Execute Phase**: call the single-record endpoint for only User 20's Status
  field, then wait for the first affected Order's complete computed chain.
- **Primary Metric**: `firstOrderReadyTotalMs`, initial `maxMs: 15_000`.
- **Verification**: all affected/control Orders and Purchases match the existing
  foreign-select algebra; routing asserts feature `updateRecord`.
- **Open Assumptions**: a second value type is justified because select option
  resolution and storage differ from plain text.

## Case 8: `duplicate-view/complex-grid-20fields-p95`

- **Goal**: fill the uncovered `duplicateView` V2 canary surface with a grid
  view that carries real filter, sort, group, and column metadata.
- **Runner**: `duplicate-view` (new direct runner; no existing runner expresses
  repeated view metadata duplication cleanly).
- **Seed Phase**: create one empty 20-field mixed table, then configure its grid
  view with deterministic filters, sorts, groups, and column widths/order.
- **Execute Phase**: one untimed warmup followed by 30 independent duplicates of
  the original view; collect per-request timings.
- **Primary Metric**: `duplicateViewP95Ms`, initial `maxMs: 2_000`.
- **Verification**: every response is 201; first/last routing matches the engine;
  duplicated views preserve type, filter, sort, group, and column metadata; the
  original view remains unchanged.
- **Open Assumptions**: row data is intentionally absent because both product
  implementations duplicate view metadata, not records; repeated samples make
  the otherwise short request measurable without changing one-request semantics.

## Case 9: `field-restore/10k-status-field`

- **Goal**: measure restoring 10,000 populated single-select cells, complementing
  the existing long-text restore case.
- **Runner**: `field-restore` (reuse).
- **Seed Phase**: existing deterministic 10k mixed table.
- **Execute Phase**: delete `Status` as setup, then measure V1 direct restore or
  V2 restore stream.
- **Primary Metric**: `restoreFieldMs`, initial `maxMs: 120_000`.
- **Verification**: restored field id/name and all 10,000 select values match the
  deterministic cycle; delete and restore routes match the engine.
- **Open Assumptions**: select restoration is materially distinct from long
  text because it exercises option-backed cell serialization.

## Case 10: `field-restore/10k-start-date-field`

- **Goal**: measure restoring 10,000 populated date cells and their formatting
  metadata.
- **Runner**: `field-restore` (reuse).
- **Seed Phase**: existing deterministic 10k mixed table with UTC-stable date
  values.
- **Execute Phase**: delete `Start Date` as setup, then measure the engine's
  restore path.
- **Primary Metric**: `restoreFieldMs`, initial `maxMs: 120_000`.
- **Verification**: restored field metadata exists and a full scan matches every
  deterministic date value.
- **Open Assumptions**: date is the second restore value family because its
  formatting and serialized representation differ from text/select.

## Explicit Rejections for This Batch

- Do not add `table-create/1x-20f-10k-records`: the prior local V1 run proved
  that shape unstable; 5k is the accepted dual-engine maximum for now.
- Do not add larger duplicate-table variants: prior attempts hit V1 402 limits.
- Do not add more conditional lookup/rollup fanout points: the existing matrix
  is already dense and the marginal diagnostic value is lower than the gaps
  above.
- Do not add schema-repair cases: deliberately corrupting physical/meta state is
  deferred until a safe fixture contract exists.
