import { definePerfCase } from "../../framework/types";
import { scalarFieldDelete50kConfig } from "../field-delete.shared";

export default definePerfCase({
  id: "field-delete/50k-delete-owner-text-field",
  title: "Delete one populated text field from 50k rows",
  runner: "field-delete",
  timeoutMs: 1_800_000,
  watchdogMs: 600_000,
  config: {
    ...scalarFieldDelete50kConfig("Owner Text", "owner-text"),
    threshold: { metric: "deleteFieldMs", maxMs: 10_000 },
  },
});
