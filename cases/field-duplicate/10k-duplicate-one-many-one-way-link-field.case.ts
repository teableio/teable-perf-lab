import { definePerfCase } from "../../framework/types";
import { linkFieldDuplicateConfig } from "../field-duplicate-link.shared";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-one-many-one-way-link-field",
  title: "Duplicate one populated one-way one-many Link field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...linkFieldDuplicateConfig("oneMany", true, "one-many-one-way", "OM-FK"),
    threshold: { metric: "duplicateLinkFieldMs", maxMs: 180_000 },
  },
});
