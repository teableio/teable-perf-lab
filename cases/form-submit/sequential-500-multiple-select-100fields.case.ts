import { definePerfCase } from "../../framework/types";
import {
  formSubmit100Fields,
  formSubmit500Base,
  formSubmit500RuntimeEnv,
} from "../form-submit.shared";

export default definePerfCase({
  id: "form-submit/sequential-500-multiple-select-100fields",
  title:
    "Submit 500 100-field multiple-select records sequentially through a Form view",
  runner: "form-submit",
  timeoutMs: 1_800_000,
  runtimeEnv: formSubmit500RuntimeEnv,
  config: {
    ...formSubmit500Base,
    tableNamePrefix: "perf-form-submit-500-multiple-select-100fields",
    fields: formSubmit100Fields.multipleSelect100,
    threshold: { metric: "formSubmitP95Ms", maxMs: 5_000 },
  },
});
