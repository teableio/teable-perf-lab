import { definePerfCase } from "../../framework/types";
import {
  formSubmit50Base,
  formSubmit50Fields,
  formSubmit50RuntimeEnv,
} from "../form-submit.shared";

export default definePerfCase({
  id: "form-submit/sequential-50-primary-only",
  title: "Submit 50 primary-only records sequentially through a Form view",
  runner: "form-submit",
  timeoutMs: 600_000,
  runtimeEnv: formSubmit50RuntimeEnv,
  config: {
    ...formSubmit50Base,
    tableNamePrefix: "perf-form-submit-50-primary-only",
    fields: formSubmit50Fields.primaryOnly,
    threshold: { metric: "formSubmitP95Ms", maxMs: 2_000 },
  },
});
