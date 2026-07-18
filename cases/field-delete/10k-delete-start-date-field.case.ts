import { definePerfCase } from "../../framework/types";
import { scalarFieldDeleteConfig } from "../field-delete.shared";

export default definePerfCase({
  id: "field-delete/10k-delete-start-date-field",
  title: "Delete one populated date field from 10k rows",
  runner: "field-delete",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  config: {
    ...scalarFieldDeleteConfig("Start Date", "start-date"),
    threshold: { metric: "deleteFieldMs", maxMs: 10_000 },
  },
});
