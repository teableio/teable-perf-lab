---
owner: backend-v2
tags:
  - lookup
  - link
  - computed
  - formula
  - rollup
  - 2k
  - v1-v2
  - relationship
enabled: true
---

# lookup/dual-link-computed-repoint-2k

## Goal

Measure how long after a data write the V2 dependency graph becomes readable, on
a deep, customer-mirrored schema, when the links already exist and are re-pointed
to different records. This is the `A -> B` switch variant of
`lookup/dual-link-computed-first-link-4k`: orders are seeded already linked, then
every link is re-pointed, forcing all dependent lookups, multi-level formulas, and
downstream cross-table rollups to recompute. It reproduces the customer "orders"
scenario where the link targets change but the lookups (`user_email`,
`shipping_first_name`, ...) and the `${first_name} ${last_name}` formula lag for a
window.

The case runs in two computed-update modes (workflow input `computed_update_mode`):

- **sync** (default e2e behavior): V2 recomputes the graph inside the write
  transaction; the V1/V2 comparison is a write-throughput comparison.
- **hybrid** (production behavior): V2 enqueues the recompute into the
  `computed_update_outbox` and drains it through the BullMQ wake-up worker; the metric then
  captures the real async propagation window.

## Seed Phase

Mirrors a bounded version of the customer schema across four tables:

- `users` (registered customer) and `guest`, 2,000 rows each, with a `Key`
  primary plus 10 attribute columns (`first_name`, `last_name`, `email`, `phone`,
  `address_1`, `address_2`, `country`, `state`, `postcode`, `city`).
- `orders`, 2,000 rows, with `Title`, two one-way many-one links
  (`customer_id_fk` -> users, `gust_email_fk` -> guest), a two-way many-one
  `purchase_fk` -> purchase, **20 lookups** (10 over each link), and a **4-level
  formula chain** over them: L1 `customer_name`/`guest_name`/`ship_address`/
  `contact` (over lookups), L2 `summary` (over the L1 formulas), L3 `order_card`
  (over `summary`).
- `purchase`, 200 rows, each grouping 10 consecutive orders. It rolls up its
  orders — `p_order_count` (COUNTALL), `p_names` (ARRAY_JOIN of `customer_name`),
  `p_emails` (ARRAY_JOIN of `cust_email`) — and a formula `p_label` over the
  rollup. This is the **second cascade hop**: order computed values feed purchase
  rollups.
- In `repoint` mode each order row `i` is seeded linked to foreign row `i`
  (identity) for both customer and guest, so the whole graph starts populated for
  the identity permutation.
- With seed caching the four tables are named from `seedHash` and built once into
  the seed dump; the seeded order ids and foreign/purchase table ids are
  persisted in the orders table description. `seedReady` revalidates that the
  sample order rows still resolve to the seed (identity) foreign row.

## Execute Phase

1. Verify seed order samples resolve to the identity permutation (`seedReady`).
2. Execute setup (not measured): scan `users` and `guest` to map titles to ids.
3. `PATCH /api/table/{tableId}/record` (100-row batches; the V1 synchronous
   recompute path times out on larger batches)
   re-pointing both `customer_id_fk` and `gust_email_fk` for every order row `i`
   to foreign row `((i-1)*7+3) % 2000 + 1`. multiplier 7 is coprime with 2,000,
   so the mapping is a permutation and no row keeps its seed target.
4. Start the primary timer after the write response and poll a full paged scan of
   all 2,000 orders **and** all 200 purchases until every lookup, formula,
   rollup, and downstream value matches the re-pointed target, then stop the
   timer. Assert routing matches the requested engine.
5. Cleanup restores the order link cells to the seed (identity) permutation on
   local single-database runs; isolated execute databases are discarded by
   teardown.

## Primary Metric

- `lookupPropagationMs`: elapsed time after the link write response until the
  entire dependency graph (orders lookups + formulas + purchase rollups) reflects
  the re-pointed links. This isolates the read-after-write computed readiness
  window that exposes the V2 hybrid outbox lag.

Diagnostics: `linkWriteMs` (the PATCH batches only) and `lookupReadyTotalMs`
(write plus propagation). Seeding, the id scans, and seed validation stay out of
the primary metric.

## Verification

- The write responses must update all 2,000 records.
- A full paged scan confirms every customer/guest lookup equals the re-pointed
  foreign attribute and every formula equals its deterministic expected value;
  a purchase scan confirms each `p_order_count` equals its child count, each
  child's `customer_name`/`cust_email` appears in the rollup join, and `p_label`
  matches.

## Notes

Sized at **2,000**, not 4,000 or 10,000, on purpose. Repoint is materially
heavier than `first-link`: it invalidates the old lookup targets, computes new
targets, and re-aggregates purchase rollups. In `hybrid` (the production async
path), CI showed `first-link` 4k converging with a real async value while
`repoint` 4k timed out after 600s (run 27682892707). A local hybrid probe at 2k
passed with comfortable margin: `lookupPropagationMs` 18.0s, `linkWriteMs` 4.1s,
and `lookupReadyTotalMs` 22.1s, with 2,000 orders and 200 purchases fully
scanned. 10k remains a recorded non-convergence finding (run 27679497968), not a
target metric for this green CI standard.

`maxMs` (40,000) is calibrated 2026-06-22 from CI history of the current
`lookupPropagationMs` metric (53 v1+v2 runs; v2 worst ~15.7s, v1 worst ~0.6s),
set to ~2.5x the v2 worst for async-window margin - 7.5x tighter than the old
300,000.
For a fast local smoke, set `PERF_LAB_LCP_ROWS` / `PERF_LAB_LCP_FOREIGN_ROWS` to
shrink the workload without editing this config.
