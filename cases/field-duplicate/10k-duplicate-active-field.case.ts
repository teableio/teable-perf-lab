import { definePerfCase } from "../../framework/types";
import { scalarFieldDuplicateConfig } from "../field-duplicate-scalar.shared";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-active-field",
  title: "Duplicate one populated checkbox field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDuplicateConfig("Active", "active"),
    threshold: { metric: "duplicateScalarFieldMs", maxMs: 8_000 },
  },
});
