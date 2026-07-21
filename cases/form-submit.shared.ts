import type { FormSubmitCaseConfig } from "../framework/types";
import { scalarFieldMatrix } from "./scalar-field-matrix.shared";

export const formSubmit50Fields = scalarFieldMatrix;

export const formSubmit50RuntimeEnv = {
  PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^formSubmitP95Ms:(1|25|50)$",
  PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^formSubmitP95Ms:\\d+$",
  PERF_LAB_TRACE_FALLBACK_MAX_ATTEMPTS: 3,
};

export const formSubmit50Base = {
  baseId: "seed-base",
  rowCount: 50,
  generator: {
    type: "mixed-form-submit",
    titlePrefix: "Form row",
    payloadPrefix: "form",
    valuePrefix: "Cell",
  },
  verify: {
    sampleRows: [0, 24, 49],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  FormSubmitCaseConfig,
  "baseId" | "rowCount" | "generator" | "verify"
>;

export const formSubmit500RuntimeEnv = {
  PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^formSubmitP95Ms:(1|250|500)$",
  PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^formSubmitP95Ms:\\d+$",
  PERF_LAB_TRACE_FALLBACK_MAX_ATTEMPTS: 3,
};

export const formSubmit500Base = {
  ...formSubmit50Base,
  rowCount: 500,
  verify: {
    sampleRows: [0, 249, 499],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  FormSubmitCaseConfig,
  "baseId" | "rowCount" | "generator" | "verify"
>;
