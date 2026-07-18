import { definePerfCase } from "../../framework/types";
import { structuredFieldDuplicateConfig } from "../field-duplicate-structured.shared";

export default definePerfCase({
  id: "field-duplicate/10k-duplicate-attachments-field",
  title: "Duplicate one populated Attachment field across 10k rows",
  runner: "field-duplicate",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...structuredFieldDuplicateConfig("Attachments", "attachments"),
    threshold: { metric: "duplicateStructuredFieldMs", maxMs: 20_000 },
  },
});
