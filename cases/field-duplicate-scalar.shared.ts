import { recordReplayMixed20Fields } from "../framework/runners/record-replay.shared";
import type { ScalarFieldDuplicateCaseConfig } from "../framework/types";

const requireReplayField = (
  fieldName: string,
): ScalarFieldDuplicateCaseConfig["fields"][number] => {
  const field = recordReplayMixed20Fields.find(
    (candidate) => candidate.name === fieldName,
  );
  if (!field) {
    throw new Error(
      `Unknown scalar field-duplicate matrix field: ${fieldName}`,
    );
  }
  return field;
};

const titleField = requireReplayField("Title");

export const scalarFieldDuplicateConfig = (
  fieldName: string,
  tableNameSuffix: string,
): Omit<ScalarFieldDuplicateCaseConfig, "threshold"> => ({
  mode: "scalar",
  baseId: "seed-base",
  tableNamePrefix: `perf-field-duplicate-10k-${tableNameSuffix}`,
  rowCount: 10_000,
  batchSize: 1_000,
  fields: [titleField, requireReplayField(fieldName)],
  generator: {
    type: "mixed-undo-redo",
    titlePrefix: "Item",
    payloadPrefix: "Field duplicate",
    source: "perf-lab-field-duplicate-scalar",
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
