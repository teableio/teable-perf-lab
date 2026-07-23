import { definePerfCase } from "../../framework/types";
import {
  scalarFieldCreate50kBase,
  scalarFieldCreateTraceRuntimeEnv,
} from "../field-create.shared";
import { scalarFieldAddMatrix } from "../scalar-field-matrix.shared";

export default definePerfCase({
  id: "field-create/50k-create-10-checkbox-fields",
  title: "Create 10 checkbox fields on a 50k-record table",
  runner: "field-create",
  seedAffinity: "field-create/scalar-title-only-50k",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  runtimeEnv: scalarFieldCreateTraceRuntimeEnv(10),
  config: {
    ...scalarFieldCreate50kBase,
    tableNamePrefix: "perf-field-create-50k-10-checkbox",
    fields: scalarFieldAddMatrix.checkbox10,
    threshold: { metric: "createScalarFieldsMs", maxMs: 120_000 },
  },
});
