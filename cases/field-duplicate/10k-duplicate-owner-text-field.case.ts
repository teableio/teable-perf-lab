import { definePerfCase } from "../../framework/types";
import { scalarFieldDuplicateConfig } from "../field-duplicate-scalar.shared";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-owner-text-field",
  title: "Duplicate one populated single-line text field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDuplicateConfig("Owner Text", "owner-text"),
    threshold: { metric: "duplicateScalarFieldMs", maxMs: 10_000 },
  },
});
