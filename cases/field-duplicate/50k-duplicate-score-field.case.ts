import { definePerfCase } from "../../framework/types";
import { scalarFieldDuplicate50kConfig } from "../field-duplicate-scalar.shared";

export default definePerfCase({
  id: "field-duplicate/50k-duplicate-score-field",
  title: "Duplicate one populated rating field across 50k rows",
  runner: "field-duplicate",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDuplicate50kConfig("Score"),
    threshold: { metric: "duplicateScalarFieldMs", maxMs: 40_000 },
  },
});
