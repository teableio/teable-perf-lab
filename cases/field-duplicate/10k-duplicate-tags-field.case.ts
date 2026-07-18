import { definePerfCase } from "../../framework/types";
import { scalarFieldDuplicateConfig } from "../field-duplicate-scalar.shared";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-tags-field",
  title: "Duplicate one populated multiple-select field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDuplicateConfig("Tags", "tags"),
    threshold: { metric: "duplicateScalarFieldMs", maxMs: 8_000 },
  },
});
