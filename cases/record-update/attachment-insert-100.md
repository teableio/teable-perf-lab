---
owner: backend-v2
tags:
  - record-update
  - attachment
  - 100
  - v1-v2
  - mixed-fields
enabled: true
---

# record-update/attachment-insert-100

## Goal

Measure bulk insertion of attachment references into 100 existing records. This
isolates attachment payload validation and attachment cell serialization from
the scalar bulk-update path, matching the product action of attaching files to
many records at once.

The measured request is the multi-record update
`PATCH /api/table/{tableId}/record` (canary feature `updateRecords`).

## Seed Phase

- Creates one reusable table in the e2e seed base with `Title`
  (singleLineText) and `Files` (attachment), seeded empty.
- Inserts 100 deterministic records in a single 100-record batch with
  `Attachment row <n>` titles; the attachment column starts empty.
- With seed caching enabled the table is named from `seedHash` and built once
  into the seed dump. Seeded record ids are persisted in the table description
  so cache hits can address the same rows. `seedReady` revalidates titles, row
  count, and that the attachment column is still empty (a crashed prior run
  that left attachments behind fails this and rebuilds).

## Execute Phase

1. Verify seed samples and the empty attachment column (`seedReady`).
2. Execute setup (not measured): upload two deterministic small text files to
   the first seeded record through the upload-attachment endpoint to obtain
   valid attachment tokens. Each token must exist in the attachments table for
   the bulk update to accept it.
3. Warmup (not measured): run the bulk insert once so the per-request v2
   container/context construction, prepared statements, and connection pools
   are hot before sampling.
4. Sampled measurement: repeat the same `PATCH /api/table/{tableId}/record`
   (`fieldKeyType: "id"`, `typecast: false`, inserting the two uploaded
   attachment items `{ token, name }` into all 100 records) `samples` times
   (default 20, overridable with `PERF_LAB_SAMPLES`), timing each request. The
   request is idempotent, so every sample writes the same final state.
5. Assert the routing of a sampled response matches the requested V1/V2 engine.
6. Verify sample rows (offsets 0 / 49 / 99) then full-scan all 100 rows; each
   attachment cell must expose exactly the two expected tokens.
7. Cleanup clears the attachment cells back to empty on local single-database
   runs; isolated execute databases are discarded by job teardown.

## Primary Metric

- `bulkUpdate100AttachmentCellsP95Ms`: the p95 of the sampled bulk
  attachment-insert requests (the one warmup request is excluded). A small
  fixed payload at 100 rows makes single-shot timings noisy, so the case warms
  up, samples, and reports the p95.

Diagnostics recorded separately: `attachmentUpdateMinMs` /
`attachmentUpdateP50Ms` / `attachmentUpdateMaxMs`, `attachmentUpdateSamples`,
`warmupUpdateMs`, the upload setup `uploadSetupMs`, and sample verification
`verifyUpdatedMs`. Seeding and seed validation stay out of the primary metric.

## Verification

- The update response must contain 100 updated record ids.
- Every record's attachment cell holds exactly the two uploaded tokens.

## Notes

Attachment tokens must reference real uploaded attachments, so the file set is
uploaded fresh during each execute run rather than cached: the seed dump
captures the database, not the storage volume. `maxMs` (2,000) is
calibrated 2026-06-22 from CI history (93 v1+v2 runs; p95 ~320ms, worst ~450ms).
This is a sub-second p95 metric, so it is floored at 2,000 ms rather than 2x the
worst to keep headroom for CI variance.
