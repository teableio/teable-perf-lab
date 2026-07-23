import { definePerfCase } from "../../framework/types";
import {
  scalarFieldCreate50kBase,
  scalarFieldCreateTraceRuntimeEnv,
} from "../field-create.shared";
import { scalarFieldAddMatrix } from "../scalar-field-matrix.shared";

export default definePerfCase({
  id: "field-create/50k-create-1-single-line-text-field",
  title: "Create 1 single-line text field on a 50k-record table",
  runner: "field-create",
  seedAffinity: "field-create/scalar-title-only-50k",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  runtimeEnv: scalarFieldCreateTraceRuntimeEnv(1),
  config: {
    ...scalarFieldCreate50kBase,
    tableNamePrefix: "perf-field-create-50k-1-single-line-text",
    fields: scalarFieldAddMatrix.singleLineText1,
    threshold: { metric: "createScalarFieldsMs", maxMs: 30_000 },
  },
});
