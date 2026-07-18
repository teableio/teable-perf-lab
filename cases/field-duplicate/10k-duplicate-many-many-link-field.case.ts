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
    // CI runs 29649057939 and 29650023288: V1 worst 46.53s, V2 worst 0.79s.
    threshold: { metric: "duplicateLinkFieldMs", maxMs: 100_000 },
  },
});
