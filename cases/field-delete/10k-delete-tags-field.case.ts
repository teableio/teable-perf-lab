import { definePerfCase } from "../../framework/types";
import { scalarFieldDeleteConfig } from "../field-delete.shared";

export default definePerfCase({
  id: "field-delete/10k-delete-tags-field",
  title: "Delete one populated multiple-select field from 10k rows",
  runner: "field-delete",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDeleteConfig("Tags", "tags"),
    threshold: { metric: "deleteFieldMs", maxMs: 2_000 },
  },
});
