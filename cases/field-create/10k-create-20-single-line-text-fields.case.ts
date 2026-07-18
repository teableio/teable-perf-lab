import { definePerfCase } from "../../framework/types";
import {
  scalarFieldCreateBase,
  scalarFieldCreateTraceRuntimeEnv,
} from "../field-create.shared";
import { scalarFieldAddMatrix } from "../scalar-field-matrix.shared";

export default definePerfCase({
  id: "field-create/10k-create-20-single-line-text-fields",
  title: "Create 20 single-line text fields on a 10k-record table",
  runner: "field-create",
  timeoutMs: 600_000,
  watchdogMs: 300_000,
  runtimeEnv: scalarFieldCreateTraceRuntimeEnv(20),
  config: {
    ...scalarFieldCreateBase,
    tableNamePrefix: "perf-field-create-10k-20-single-line-text",
    fields: scalarFieldAddMatrix.singleLineText20,
    threshold: { metric: "createScalarFieldsMs", maxMs: 40_000 },
  },
});
