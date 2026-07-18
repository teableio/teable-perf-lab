import { definePerfCase } from "../../framework/types";
import {
  scalarFieldCreateBase,
  scalarFieldCreateTraceRuntimeEnv,
} from "../field-create.shared";
import { scalarFieldAddMatrix } from "../scalar-field-matrix.shared";

export default definePerfCase({
  id: "field-create/10k-create-10-number-fields",
  title: "Create 10 number fields on a 10k-record table",
  runner: "field-create",
  timeoutMs: 600_000,
  watchdogMs: 300_000,
  runtimeEnv: scalarFieldCreateTraceRuntimeEnv(10),
  config: {
    ...scalarFieldCreateBase,
    tableNamePrefix: "perf-field-create-10k-10-number",
    fields: scalarFieldAddMatrix.number10,
    threshold: { metric: "createScalarFieldsMs", maxMs: 20_000 },
  },
});
