import { definePerfCase } from "../../framework/types";
import baseCase from "./10k-3tables-link-2workflow.case";

export default definePerfCase({
  id: "duplicate-base/10k-3tables-link-2workflow-stream",
  title:
    "Duplicate a 10k 3-table linked base through the product stream endpoint",
  runner: "duplicate-base",
  timeoutMs: 900_000,
  config: {
    ...baseCase.config,
    operation: "duplicate-stream",
    duplicate: {
      ...baseCase.config.duplicate,
      namePrefix: "perf-duplicate-base-copy-stream",
    },
    threshold: {
      metric: "duplicateBaseStreamMs",
      maxMs: 180_000,
    },
  },
});
