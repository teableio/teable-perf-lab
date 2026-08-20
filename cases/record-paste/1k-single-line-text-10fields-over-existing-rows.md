---
owner: backend-v2
tags:
  - record-paste
  - paste
  - paste-by-id
  - 1k
  - text
  - v1-v2
enabled: true
---

# record-paste/1k-single-line-text-10fields-over-existing-rows

## Goal

Measure grid paste performance when the paste lands on 1,000 rows that already
exist and are addressed by their record ids, rather than creating rows in an
empty table.

## Why this shape is not already covered

Every other paste case sends `selection.recordIds: []` — no rows selected, so
the paste creates all of them. The one case that does send ids
(`selection-paste/10k-expand-rows-and-fields-stream`) sends **ten**, because it
seeds ten rows and expands to ten thousand. `selection-clear` deliberately uses
`allRecords: true` instead of a list, so its seed cache can hydrate row counts
without real ids.

So the body a user actually produces by selecting a block of existing rows and
pressing paste — a `recordIds` list as long as the selection — has not been
measured at any size. That list is what the server has to resolve into records
before it can write, which makes it the one paste shape where the cost of
loading the selection scales with the selection.

## Seed Phase

- No reusable records are seeded across runs; this is a single-use fixture.
- Execute setup creates the table with `Title` plus nine text fields, then
  inserts 1,000 **blank** rows in batches of 1,000 and keeps their ids.
- Rows are blank on purpose: the post-paste full scan then proves the paste
  wrote every cell, instead of reading back values a seed had already put
  there.
- All of this happens inside the fixture phase, before the primary timer
  starts, and is reported as `prepareFixture`.

## Execute Phase

1. Paste the 1,000 × 10 TSV block over the seeded rows. V2 sends
   `PATCH /selection/paste-by-id` with all 1,000 ids in `selection.recordIds`;
   V1 sends the range paste anchored at the first cell, which is the same user
   action through V1's grid.
2. Assert the response status and the V1/V2 route.
3. Assert that **no** records were created — pasting over existing rows must
   update them, and a silently expanding paste would otherwise pass as an
   update.
4. Stop the timer, then full scan all 1,000 records and compare all ten cells.
5. Preserve exact samples for rows 1, 500, and 1,000 and clean up the table.

## Primary Metric

- `pasteOver1kMs`: elapsed time for the paste request and its response
  assertions; guardrail `maxMs: 6_000`.

## Notes

First measurement, Actions run 32360582474 against teable-ee develop: **v1
1,469ms, v2 926ms**, both passing with routing matched. That is close enough to
the create-paste sibling (`record-paste/1k-single-line-text-10fields`, v1
1,690ms / v2 781ms) that resolving 1,000 selected records costs far less than
the doubled guardrail this case shipped with assumed, so it now shares the
sibling's 6,000ms.

One run is not a calibration. The guardrail keeps the same shape as its
siblings — roughly four times the worst observed v1 — and should be replaced
from run percentiles once this case has history.

Verification and cleanup are outside the primary timer.
