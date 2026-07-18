import { definePerfCase } from "../../framework/types";
import { linkFieldDuplicateConfig } from "../field-duplicate-link.shared";

export default definePerfCase({
  id: "field-duplicate/v2-only-10k-duplicate-one-one-link-field",
  title: "V2-only: duplicate one populated one-one Link field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...linkFieldDuplicateConfig("oneOne", false, "one-one", "OO-FK"),
    v2Only: {
      reason:
        "V1 duplicateField tries to add a second one-one constraint with the source constraint name and PostgreSQL returns 42710 duplicate_object; V2 has a distinct supported SQL copy path.",
    },
    // CI run 29650023288: native V2 duplicate completed in 1.12s.
    threshold: { metric: "duplicateLinkFieldMs", maxMs: 5_000 },
  },
});
