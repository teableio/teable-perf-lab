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
const scalarMatrixFieldNames = [
  "Owner Text",
  "Description",
  "Amount",
  "Start Date",
  "Active",
  "Status",
  "Tags",
  "Score",
];

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

export const scalarFieldDuplicate50kConfig = (
  fieldName: string,
): Omit<ScalarFieldDuplicateCaseConfig, "threshold"> => ({
  mode: "scalar",
  baseId: "seed-base",
  tableNamePrefix: "perf-field-duplicate-scalar-50k",
  seedIdentity: "scalar-matrix-50k",
  rowCount: 50_000,
  batchSize: 1_000,
  fields: [
    titleField,
    ...scalarMatrixFieldNames.map((name) => requireReplayField(name)),
  ],
  generator: {
    type: "mixed-undo-redo",
    titlePrefix: "Item",
    payloadPrefix: "Field duplicate",
    source: "perf-lab-field-duplicate-scalar-50k",
  },
  verify: {
    sampleRows: [0, 24_999, 49_999],
    fullScanPageSize: 1_000,
  },
  duplicate: {
    sourceFieldName: fieldName,
    name: `${fieldName} Copy`,
  },
});
