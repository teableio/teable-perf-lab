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
    // CI runs 29649057939 and 29650023288: V1 worst 62.88s; native V2 0.92s.
    threshold: { metric: "duplicateLinkFieldMs", maxMs: 140_000 },
  },
});
