import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/attachment-insert-100",
  title: "Bulk insert attachment references into 100 records",
  runner: "record-update-attachment",
  timeoutMs: 300_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-update-attachment-insert-100",
    rowCount: 100,
    batchSize: 100,
    attachmentFieldName: "Files",
    // Uploaded once during execute setup (not measured) to obtain valid tokens
    // the bulk update can reference. Each token must exist in the attachments
    // table for the update to accept it.
    attachments: [
      {
        filename: "perf-attachment-1.txt",
        content: "perf-lab attachment payload one",
        mimetype: "text/plain",
      },
      {
        filename: "perf-attachment-2.txt",
        content: "perf-lab attachment payload two",
        mimetype: "text/plain",
      },
    ],
    attachmentsPerCell: 2,
    // The bulk-insert request is idempotent (same tokens written each time),
    // so it is run once as warmup then sampled; the primary metric is the p95.
    // 20 samples keeps the p95 off the single max sample.
    samples: 20,
    generator: {
      type: "attachment-record-update",
      titlePrefix: "Attachment row",
    },
    verify: {
      sampleRows: [0, 49, 99],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "bulkUpdate100AttachmentCellsP95Ms",
      // Calibrated 2026-06-22 from 93 CI runs (v1+v2, Apr-Jun 2026): p95 ~318ms,
      // worst ~447ms. Sub-second metric floored at 2_000ms (not 2x worst) to keep
      // headroom for CI variance on a noisy small metric (was 60_000).
      maxMs: 2_000,
    },
  },
});
