import { recordReplayMixed20Fields } from "../framework/runners/record-replay.shared";
import type {
  LinkFieldDuplicateCaseConfig,
  LinkRelationshipKind,
} from "../framework/types";

const titleField = recordReplayMixed20Fields.find(
  (field) => field.name === "Title",
);
if (!titleField) {
  throw new Error("Record replay fixture is missing its Title field");
}

export const linkFieldDuplicateConfig = (
  relationship: LinkRelationshipKind,
  isOneWay: boolean,
  tableNameSuffix: string,
  keyPrefix: string,
): Omit<LinkFieldDuplicateCaseConfig, "threshold"> => ({
  mode: "link",
  baseId: "seed-base",
  tableNamePrefix: `perf-field-duplicate-link-10k-${tableNameSuffix}`,
  rowCount: 10_000,
  batchSize: 1_000,
  fields: [titleField],
  generator: {
    type: "mixed-undo-redo",
    titlePrefix: "Item",
    payloadPrefix: "Link field duplicate",
    source: "perf-lab-field-duplicate-link",
  },
  verify: {
    sampleRows: [0, 4_999, 9_999],
    fullScanPageSize: 1_000,
  },
  link: {
    fieldName: "Related",
    relationship,
    isOneWay,
    foreignTable: {
      rowCount: 10_000,
      batchSize: 1_000,
      keyPrefix,
    },
    permutation: {
      multiplier: 1,
      offset: 0,
    },
  },
  duplicate: {
    sourceFieldName: "Related",
    name: "Related Copy",
  },
});
