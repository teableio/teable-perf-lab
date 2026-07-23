import { definePerfCase } from "../../framework/types";
import { scalarFieldDuplicate50kConfig } from "../field-duplicate-scalar.shared";

export default definePerfCase({
  id: "field-duplicate/50k-duplicate-description-field",
  title: "Duplicate one populated long-text field across 50k rows",
  runner: "field-duplicate",
  seedAffinity: "field-duplicate/scalar-matrix-50k",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDuplicate50kConfig("Description"),
    threshold: { metric: "duplicateScalarFieldMs", maxMs: 40_000 },
  },
});
