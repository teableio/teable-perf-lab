import { FieldType } from "@teable/core";
import type { FieldCreateCaseConfig } from "../framework/types";

export const scalarFieldCreateTraceRuntimeEnv = (fieldCount: number) => {
  const selectedIterations = [
    1,
    fieldCount === 20 ? 10 : Math.ceil(fieldCount / 2),
    fieldCount,
  ];
  const pattern = [...new Set(selectedIterations)].join("|");
  return {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: `^createScalarFieldsMs:(${pattern})$`,
    PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^createScalarFieldsMs:\\d+$",
    PERF_LAB_TRACE_FALLBACK_MAX_ATTEMPTS: 3,
  };
};

export const scalarFieldCreateBase = {
  baseId: "seed-base",
  seedIdentity: "scalar-title-only-10k",
  rowCount: 10_000,
  batchSize: 1_000,
  baseFields: [{ name: "Title", type: FieldType.SingleLineText }],
  tracePerField: true,
  generator: {
    type: "title-sequence",
    titlePrefix: "Scalar field row",
  },
  verify: {
    fullScanPageSize: 1_000,
    emptyCreatedFields: true,
  },
} satisfies Omit<
  FieldCreateCaseConfig,
  "tableNamePrefix" | "field" | "fields" | "ready" | "threshold"
>;

export const scalarFieldCreate50kBase = {
  ...scalarFieldCreateBase,
  seedIdentity: "scalar-title-only-50k",
  rowCount: 50_000,
} satisfies Omit<
  FieldCreateCaseConfig,
  "tableNamePrefix" | "field" | "fields" | "ready" | "threshold"
>;
