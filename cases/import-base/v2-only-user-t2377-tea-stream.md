---
owner: perf-lab
tags:
  - import-base
  - stream
  - user-fixture
  - schema
  - workflow
  - app
  - v2-only
enabled: true
---

# import-base/v2-only-user-t2377-tea-stream

## Goal

Measure importing the user-provided `T2377.tea` package through the V2 product
SSE progress path when the imported base contains many real tables, fields,
views, one app package, and workflow metadata.

## Seed Phase

No generated source base is created. The repo fixture at
`cases/import-base/fixtures/T2377.tea` is the deterministic source package, and
the seed phase uploads it through the product attachment flow once to validate it.
The seed cache restores only the PostgreSQL database, not the backend
`.assets/uploads` directory, so the execute job re-uploads the fixture (which is
checked out in the repo) rather than reusing the seed-phase upload.

The package was inspected as:

- 52 tables;
- 1 app package (`复试培训报告系统`);
- 1 workflow (`新自动化 2`);
- structure-only table records in the archive.

## Execute Phase

1. Upload `T2377.tea` through the product attachment signature/upload/notify
   flow (outside the primary metric) to produce a fresh import `notify` payload
   whose file exists on this runner.
2. Call `POST /api/base/import-stream` with `{ spaceId, notify }` and record
   the stream response time as `importBaseStreamMs`.
3. Read the SSE response until the `done` event and assert no stream error
   events occurred.
4. Assert import-base routing headers match V2.
5. Verify the imported base exposes 52 tables and spot-check representative
   complex tables:
   - `全阶段报告`: 100 fields, 1 view;
   - `培训名单汇总版`: 82 fields, 7 views;
   - `培训报告一阶段`: 60 fields, 1 view.
6. Verify workflow count/name best-effort when the workflow API is available.
7. Permanently delete the imported result base.

## Primary Metric

- `importBaseStreamMs`: elapsed time from sending the import stream request until
  the SSE `done` event is received.

Uploading, attachment notify, and post-import structure verification are
diagnostics outside the threshold metric.

## Notes

This case is V2-only. The legacy V1 import path is no longer maintained. Unlike
the generated simple/complex import-base cases, this case protects a real
user-reported `.tea` package and focuses on schema/app/workflow import
correctness rather than record throughput.
