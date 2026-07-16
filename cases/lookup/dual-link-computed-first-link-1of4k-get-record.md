---
owner: backend-v2
tags:
  - lookup
  - link
  - computed
  - read-after-write
  - get-record
  - 4k
  - v1-v2
enabled: true
---

# lookup/dual-link-computed-first-link-1of4k-get-record

## Goal

Measure the customer-visible lookup gap after first-linking one order inside a
4,000-row deep computed graph, using the direct single-record API as the
readiness path. This separates single-write fixed latency from the bulk
throughput measured by `lookup/dual-link-computed-first-link-4k`.

## Seed Phase

Create the same bounded customer schema as the 4k bulk first-link case:

- 4,000 `users` and 4,000 `guest` records with 10 attributes each.
- 4,000 initially unlinked `orders`, with two links, 20 lookups, the same
  three dependency levels of formulas, and a `purchase_fk` relationship.
- 400 `purchase` records, each rolling up 10 orders and deriving a formula over
  the rollup.

The mutation/read configuration is execute-only. It does not change the seed
shape: order offset 1,999 is the deterministic target and all orders start with
empty customer/guest links.

## Execute Phase

1. Confirm the three seed samples are still unlinked.
2. Resolve foreign record ids outside the metric.
3. PATCH both links on exactly one order (offset 1,999).
4. After the PATCH response, poll `GET /record/{recordId}` every 100 ms until all
   20 lookups and the complete order formula chain match the new targets.
5. Stop the primary timer, then wait for one full 4,000-order plus 400-purchase
   cascade scan. This proves final correctness without charging the bulk scan to
   the single-record read-after-write metric.
6. On a reusable local database, clear the one mutated order back to the seed
   state; isolated CI databases are discarded.

## Primary Metric

- `lookupPropagationMs`: time from the one-record PATCH response until the
  direct `getRecord` response exposes the correct lookup and formula values.

Diagnostics include `linkWriteMs`, `lookupReadyTotalMs`, and
`cascadeVerificationMs`. The initial `maxMs` is 10 seconds: the customer-reported
failure boundary. The first local V1/V2 hybrid run measured 36 ms/189 ms, leaving
substantial environment-noise margin while still failing on a customer-class
empty window.

## Verification

- The write must request and update exactly one record.
- The primary read must return that exact record id with all 20 lookup values
  and every order formula correct.
- After the primary timer, a paged full scan proves the mutated row is linked,
  all 3,999 untouched rows remain unlinked, and all purchase rollups/formulas
  reflect that partial mutation.
- Routing headers from the PATCH must match the requested V1/V2 engine.

## Notes

This case intentionally writes both customer and guest links to keep the
computed graph identical to the existing dual-link bulk baseline. The customer
application normally chooses one branch per order; a one-branch field-graph
comparison is a separate axis and is not inferred from this read-path pair.

Pair this case with
`lookup/dual-link-computed-first-link-1of4k-get-records`. The seed, mutation,
poll interval, computed graph, and verification are the same; only the API used
for the primary readiness read changes.
