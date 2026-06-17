---
owner: backend-v2
tags:
  - lookup
  - link
  - computed
  - formula
  - rollup
  - 10k
  - v1-v2
  - relationship
enabled: true
---

# lookup/dual-link-computed-first-link-10k

## Goal

Measure the V2 async-compute propagation window after a data write on a deep,
customer-mirrored dependency graph: how long after the order links are written do
every dependent lookup, multi-level formula, and downstream cross-table rollup
become readable. This reproduces the customer "orders" scenario where the links
(`customer_id_fk`, `gust_email_fk`) had record ids immediately but the lookups
(`user_email`, `shipping_first_name`, ...) and the `${first_name} ${last_name}`
formula were still null for a window, producing `undefined undefined`. This
`first-link` variant is the closest to the customer "new record first
association" worst case: orders start with no customer/guest link at all.

V1 computes the whole graph synchronously inside the write (window near zero); V2
computes it asynchronously, so the metric exposes the queue drain time on a data
write (distinct from `lookup/conditional-10k`, which times recompute after field
_creation_).

## Seed Phase

Mirrors a bounded version of the customer schema across four tables:

- `users` (registered customer) and `guest`, 10,000 rows each, with a `Key`
  primary plus 10 attribute columns (`first_name`, `last_name`, `email`, `phone`,
  `address_1`, `address_2`, `country`, `state`, `postcode`, `city`).
- `orders`, 10,000 rows, with `Title`, two one-way many-one links
  (`customer_id_fk` -> users, `gust_email_fk` -> guest), a two-way many-one
  `purchase_fk` -> purchase, **20 lookups** (10 over each link), and a **4-level
  formula chain** over them: L1 `customer_name`/`guest_name`/`ship_address`/
  `contact` (over lookups), L2 `summary` (over the L1 formulas), L3 `order_card`
  (over `summary`).
- `purchase`, 1,000 rows, each grouping 10 consecutive orders. It rolls up its
  orders — `p_order_count` (COUNTALL), `p_names` (ARRAYJOIN of `customer_name`),
  `p_emails` (ARRAYJOIN of `cust_email`) — and a formula `p_label` over the
  rollup. This is the **second cascade hop**: order computed values feed purchase
  rollups.
- In `first-link` mode orders are seeded with **no** customer/guest link (only
  the static `purchase_fk` grouping), so every lookup, formula, and downstream
  rollup starts empty.
- With seed caching the four tables are named from `seedHash` and built once into
  the seed dump; the seeded order ids and foreign/purchase table ids are
  persisted in the orders table description. `seedReady` revalidates that the
  sample order rows still have empty lookups.

## Execute Phase

1. Verify seed order samples are unlinked (`seedReady`).
2. Execute setup (not measured): scan `users` and `guest` to map titles to ids.
3. Start the primary timer and `PATCH /api/table/{tableId}/record` (100-row
   batches; the V1 synchronous recompute path times out on larger batches)
   writing both `customer_id_fk` and `gust_email_fk` for every order row `i` to
   foreign row `((i-1)*7+3) % 10000 + 1` (the first links these rows get).
4. Keep the timer running and poll a full paged scan of all 10,000 orders **and**
   all 1,000 purchases until every lookup, formula, rollup, and downstream value
   matches, then stop the timer. Assert routing matches the requested engine.
5. Cleanup clears the order link cells back to empty on local single-database
   runs; isolated execute databases are discarded by teardown.

## Primary Metric

- `lookupReadyTotalMs`: elapsed time from the start of the link write until the
  entire dependency graph (orders lookups + formulas + purchase rollups) reflects
  the new links — i.e. the write plus the async recompute window.

Diagnostics: `linkWriteMs` (the PATCH batches only) and `lookupPropagationMs`
(the window after the write until everything is readable). Seeding, the id scans,
and seed validation stay out of the primary metric.

## Verification

- The write responses must update all 10,000 records.
- A full paged scan confirms every customer/guest lookup equals the linked
  foreign attribute and every formula equals its deterministic expected value;
  a purchase scan confirms each `p_order_count` equals its child count, each
  child's `customer_name`/`cust_email` appears in the rollup join, and `p_label`
  matches.

## Notes

Sized at 10,000 orders + 10,000 foreign rows + a downstream rollup table to
create real queue pressure and a deep cross-table cascade, so the V2 async window
has somewhere to grow (the real customer base is 120k+ rows and more complex).
Initial `maxMs` (300,000) is a wide guardrail; tighten after real V1/V2 history.
For a fast local smoke, set `PERF_LAB_LCP_ROWS` / `PERF_LAB_LCP_FOREIGN_ROWS` to
shrink the workload without editing this config.
