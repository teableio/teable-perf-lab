import { definePerfCase } from "../../framework/types";
import { linkFieldDuplicateConfig } from "../field-duplicate-link.shared";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-many-one-link-field",
  title: "Duplicate one populated many-one Link field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...linkFieldDuplicateConfig("manyOne", false, "many-one", "MO-FK"),
    threshold: { metric: "duplicateLinkFieldMs", maxMs: 180_000 },
  },
});
