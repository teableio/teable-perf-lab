import { definePerfCase } from "../../framework/types";
import { scalarFieldDeleteConfig } from "../field-delete.shared";

export default definePerfCase({
  id: "field-delete/10k-delete-active-field",
  title: "Delete one populated checkbox field from 10k rows",
  runner: "field-delete",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDeleteConfig("Active", "active"),
    threshold: { metric: "deleteFieldMs", maxMs: 2_000 },
  },
});
