---
owner: backend-v2
tags:
  - record-update
  - attachment
  - 1k
  - v1-v2
enabled: true
---

# record-update/attachment-insert-1k

## Goal

Measure bulk insertion of two attachment references into 1,000 existing
records, providing a higher-signal sibling to the 100-record attachment case.

## Seed Phase

- Create a reusable table with `Title` and empty `Files` attachment fields.
- Insert 1,000 deterministic records in one 1,000-record batch.
- Revalidate the row count, sample titles, and empty attachment cells on every
  seed-cache hit.

## Execute Phase

1. Upload two deterministic text files outside the primary metric.
2. Run one unmeasured warmup update.
3. Repeat the idempotent 1,000-record attachment update 20 times and compute
   P95.
4. Assert V1/V2 routing on a sampled response.
5. Verify offsets 0, 499, and 999, then full-scan all 1,000 attachment cells.
6. Clear attachment cells during reusable local cleanup.

## Primary Metric

- `bulkUpdate1kAttachmentCellsP95Ms`: P95 of the sampled bulk update requests.
  Upload, warmup, seed preparation, and verification are excluded.

## Verification

- Each response must report 1,000 updated records.
- Every attachment cell must contain exactly the two uploaded tokens.

## Notes

The initial `maxMs` is 5,000 ms, based on local V1/V2 P95s of about 370/488 ms
with wide headroom until CI measurements establish normal variance.
