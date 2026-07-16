---
owner: backend-v2
tags:
  - computed
  - outbox
  - observer
  - ab
  - measurement
  - v2-only
enabled: true
---

# computed-outbox/observer-polling-ab-10k

## Goal

Measure whether sampling the Computed Outbox database every 5 ms materially
changes the observed propagation time of the same 10,000-record depth-four
formula update compared with a 50 ms observer interval.

The 10,000-row size is deliberate: with the production 5,000-record task cap it
creates exactly two tasks, matching the production per-base concurrency of two.
That removes the large concurrency-deferral jitter that a four-task 20,000-row
run can add, so the treatment variable remains the observer interval.

## Seed Phase

- Create one deterministic 10,000-row table in the e2e seed base.
- Store `Title` and numeric `A` source fields.
- Add a four-level formula chain and verify the complete baseline chain.
- Cache the source table, formula fields, and records by the runner seed hash.

## Execute Phase

1. Run only on V2 hybrid; V1 returns an explicit skipped artifact.
2. Execute the 50 ms observer treatment first, using one external 10,000-record
   update, then wait for complete formula readiness and Outbox drain.
3. Restore the source values and verify the baseline chain and clean Outbox;
   keep this reset outside both treatment metrics.
4. Execute the same update with a 5 ms observer interval, then wait for the same
   complete formula readiness and Outbox drain.
5. Assert that both treatments saw the expected `seed` tasks, updated 10,000
   records, scanned all 10,000 final rows, and ended without failed jobs or dead
   letters.
6. Report propagation, request, computed-readiness, drain, Outbox lifetime, and
   sample-count values for each treatment plus the 5 ms minus 50 ms delta and
   ratio.

## Primary Metric

- `computedOutboxObserverAbMaxReadyMs`: the slower of the two complete
  propagation-readiness measurements.

The initial `maxMs` is 180,000 ms. The A/B delta is diagnostic and deliberately
has no pass/fail direction: one run can reveal a large perturbation, while
causal conclusions require repeated CI history.

## Notes

The fixed 50 ms then 5 ms order is conservative for the high-frequency
observer: any warm-cache advantage goes to the 5 ms treatment rather than
making it look slower because it ran first. The artifact records the treatment
order so later repetitions can be interpreted correctly.
