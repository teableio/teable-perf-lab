import { definePerfCase } from "../../framework/types";
import {
  formSubmit500Base,
  formSubmit500RuntimeEnv,
  formSubmit50Fields,
} from "../form-submit.shared";

export default definePerfCase({
  id: "form-submit/sequential-500-primary-only",
  title: "Submit 500 primary-only records sequentially through a Form view",
  runner: "form-submit",
  timeoutMs: 1_200_000,
  runtimeEnv: formSubmit500RuntimeEnv,
  config: {
    ...formSubmit500Base,
    tableNamePrefix: "perf-form-submit-500-primary-only",
    fields: formSubmit50Fields.primaryOnly,
    threshold: { metric: "formSubmitP95Ms", maxMs: 2_000 },
  },
});
