import { recordReplayMixed20Fields } from "../framework/runners/record-replay.shared";
import type { FieldDeleteCaseConfig } from "../framework/types";

const requireReplayField = (
  fieldName: string,
): FieldDeleteCaseConfig["fields"][number] => {
  const field = recordReplayMixed20Fields.find(
    (candidate) => candidate.name === fieldName,
  );
  if (!field) {
    throw new Error(`Unknown scalar field-delete matrix field: ${fieldName}`);
  }
  return field;
};

const titleField = requireReplayField("Title");

export const scalarFieldDeleteConfig = (
  fieldName: string,
  tableNameSuffix: string,
): Omit<FieldDeleteCaseConfig, "threshold"> => ({
  baseId: "seed-base",
  tableNamePrefix: `perf-field-delete-10k-${tableNameSuffix}`,
  rowCount: 10_000,
  batchSize: 1_000,
  fields: [titleField, requireReplayField(fieldName)],
  generator: {
    type: "mixed-undo-redo",
    titlePrefix: "Item",
    payloadPrefix: "Field delete",
    source: "perf-lab-field-delete-scalar",
  },
  verify: {
    sampleRows: [0, 4_999, 9_999],
    fullScanPageSize: 1_000,
  },
  delete: { fieldNames: [fieldName] },
});
