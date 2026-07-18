import { definePerfCase } from "../../framework/types";
import { linkFieldDuplicateConfig } from "../field-duplicate-link.shared";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-many-many-link-field",
  title: "Duplicate one populated many-many Link field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...linkFieldDuplicateConfig("manyMany", false, "many-many", "MM-FK"),
    threshold: { metric: "duplicateLinkFieldMs", maxMs: 180_000 },
  },
});
