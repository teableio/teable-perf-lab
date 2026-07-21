import { definePerfCase } from "../../framework/types";
import { scalarFieldDelete50kConfig } from "../field-delete.shared";

export default definePerfCase({
  id: "field-delete/50k-delete-status-field",
  title: "Delete one populated single-select field from 50k rows",
  runner: "field-delete",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...scalarFieldDelete50kConfig("Status", "status"),
    threshold: { metric: "deleteFieldMs", maxMs: 10_000 },
  },
});
