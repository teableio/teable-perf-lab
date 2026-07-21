import { definePerfCase } from "../../framework/types";
import {
  scalarFieldCreate50kBase,
  scalarFieldCreateTraceRuntimeEnv,
} from "../field-create.shared";
import { scalarFieldAddMatrix } from "../scalar-field-matrix.shared";

export default definePerfCase({
  id: "field-create/50k-create-10-multiple-select-fields",
  title: "Create 10 multiple-select fields on a 50k-record table",
  runner: "field-create",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  runtimeEnv: scalarFieldCreateTraceRuntimeEnv(10),
  config: {
    ...scalarFieldCreate50kBase,
    tableNamePrefix: "perf-field-create-50k-10-multiple-select",
    fields: scalarFieldAddMatrix.multipleSelect10,
    threshold: { metric: "createScalarFieldsMs", maxMs: 120_000 },
  },
});
