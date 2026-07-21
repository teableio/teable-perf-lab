import { definePerfCase } from "../../framework/types";
import { scalarFieldDelete50kConfig } from "../field-delete.shared";

export default definePerfCase({
  id: "field-delete/50k-delete-start-date-field",
  title: "Delete one populated date field from 50k rows",
  runner: "field-delete",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...scalarFieldDelete50kConfig("Start Date", "start-date"),
    threshold: { metric: "deleteFieldMs", maxMs: 10_000 },
  },
});
