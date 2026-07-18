import type { TableCreateCaseConfig } from "../framework/types";
import { scalarFieldMatrix } from "./scalar-field-matrix.shared";

export const tableCreate1kFields = scalarFieldMatrix;

export const tableCreate1kBase = {
  baseId: "seed-base",
  tableCount: 1,
  inlineRecords: {
    count: 1_000,
    titlePrefix: "Inline",
  },
  verify: {
    mode: "all-fields",
    sampleRows: [0, 499, 999],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  TableCreateCaseConfig,
  "baseId" | "tableCount" | "inlineRecords" | "verify"
>;
