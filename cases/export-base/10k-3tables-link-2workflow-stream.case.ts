import { definePerfCase } from "../../framework/types";
import duplicateBaseCase from "../duplicate-base/10k-3tables-link-2workflow.case";

export default definePerfCase({
  id: "export-base/10k-3tables-link-2workflow-stream",
  title: "Export a 10k 3-table linked base through the product stream endpoint",
  runner: "duplicate-base",
  timeoutMs: 900_000,
  config: {
    ...duplicateBaseCase.config,
    operation: "export-stream",
    sourceBaseNamePrefix: "perf-export-base-source-10k-3tables",
    threshold: {
      metric: "exportBaseStreamMs",
      maxMs: 180_000,
    },
  },
});
