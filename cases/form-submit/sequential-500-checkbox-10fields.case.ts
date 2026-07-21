import { definePerfCase } from "../../framework/types";
import {
  formSubmit500Base,
  formSubmit500RuntimeEnv,
  formSubmit50Fields,
} from "../form-submit.shared";

export default definePerfCase({
  id: "form-submit/sequential-500-checkbox-10fields",
  title:
    "Submit 500 ten-field checkbox records sequentially through a Form view",
  runner: "form-submit",
  timeoutMs: 1_200_000,
  runtimeEnv: formSubmit500RuntimeEnv,
  config: {
    ...formSubmit500Base,
    tableNamePrefix: "perf-form-submit-500-checkbox-10fields",
    fields: formSubmit50Fields.checkbox10,
    threshold: { metric: "formSubmitP95Ms", maxMs: 2_000 },
  },
});
