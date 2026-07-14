import { definePerfCase } from "../../framework/types";

export default definePerfCase({
  id: "record-update/attachment-insert-1k",
  title: "Bulk insert attachment references into 1k records",
  runner: "record-update-attachment",
  timeoutMs: 900_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-record-update-attachment-insert-1k",
    rowCount: 1_000,
    batchSize: 1_000,
    attachmentFieldName: "Files",
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
    samples: 20,
    generator: {
      type: "attachment-record-update",
      titlePrefix: "Attachment row",
    },
    verify: {
      sampleRows: [0, 499, 999],
      fullScanPageSize: 1_000,
    },
    threshold: {
      metric: "bulkUpdate1kAttachmentCellsP95Ms",
      // Initial scale-up guardrail from local V1/V2 p95s (~360/~473ms).
      // Keep wide CI headroom until workflow history establishes variance.
      maxMs: 5_000,
    },
  },
});
