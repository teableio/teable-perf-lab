import { definePerfCase } from "../../framework/types";
import { scalarFieldDeleteConfig } from "../field-delete.shared";

export default definePerfCase({
  id: "field-delete/10k-delete-owner-text-field",
  title: "Delete one populated single-line text field from 10k rows",
  runner: "field-delete",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDeleteConfig("Owner Text", "owner-text"),
    threshold: { metric: "deleteFieldMs", maxMs: 10_000 },
  },
});
