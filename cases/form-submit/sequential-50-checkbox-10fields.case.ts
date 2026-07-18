import { definePerfCase } from "../../framework/types";
import {
  formSubmit50Base,
  formSubmit50Fields,
  formSubmit50RuntimeEnv,
} from "../form-submit.shared";

export default definePerfCase({
  id: "form-submit/sequential-50-checkbox-10fields",
  title:
    "Submit 50 ten-field checkbox records sequentially through a Form view",
  runner: "form-submit",
  timeoutMs: 600_000,
  runtimeEnv: formSubmit50RuntimeEnv,
  config: {
    ...formSubmit50Base,
    tableNamePrefix: "perf-form-submit-50-checkbox-10fields",
    fields: formSubmit50Fields.checkbox10,
    threshold: { metric: "formSubmitP95Ms", maxMs: 2_000 },
  },
});
