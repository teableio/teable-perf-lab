import { FieldType } from "@teable/core";
import { recordReplayMixed20Fields } from "../framework/runners/record-replay.shared";
import type { StructuredFieldDuplicateCaseConfig } from "../framework/types";

const titleField = recordReplayMixed20Fields.find(
  (field) => field.name === "Title",
);
if (!titleField) {
  throw new Error("Record replay fixture is missing its Title field");
}

const structuredFields = {
  Assignee: {
    name: "Assignee",
    type: FieldType.User,
    options: { isMultiple: true, shouldNotify: false },
  },
  Attachments: {
    name: "Attachments",
    type: FieldType.Attachment,
  },
} as const;

export const structuredFieldDuplicateConfig = (
  fieldName: keyof typeof structuredFields,
  tableNameSuffix: string,
): Omit<StructuredFieldDuplicateCaseConfig, "threshold"> => ({
  mode: "structured",
  baseId: "seed-base",
  tableNamePrefix: `perf-field-duplicate-10k-${tableNameSuffix}`,
  rowCount: 10_000,
  batchSize: 1_000,
  fields: [titleField, structuredFields[fieldName]],
  generator: {
    type: "mixed-undo-redo",
    titlePrefix: "Item",
    payloadPrefix: "Field duplicate",
    source: "perf-lab-field-duplicate-structured",
  },
  verify: {
    sampleRows: [0, 4_999, 9_999],
    fullScanPageSize: 1_000,
  },
  duplicate: {
    sourceFieldName: fieldName,
    name: `${fieldName} Copy`,
  },
});
