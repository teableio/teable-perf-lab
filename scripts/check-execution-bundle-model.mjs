import assert from "node:assert/strict";
import { buildExecutionBundles } from "./execution-bundle-model.mjs";

assert.deepEqual(
  buildExecutionBundles({
    caseIds: ["a", "b", "c"],
    affinities: [{ id: "shared", caseIds: ["a", "c"] }],
  }),
  [
    { id: "shared", caseIds: ["a", "c"], firstIndex: 0 },
    { id: "case:b", caseIds: ["b"], firstIndex: 1 },
  ],
);

assert.throws(
  () =>
    buildExecutionBundles({
      caseIds: ["a", "b"],
      hybridCaseIds: ["b"],
      affinities: [{ id: "shared", caseIds: ["a", "b"] }],
    }),
  /crosses V2 sync and hybrid pools/,
);

assert.throws(
  () =>
    buildExecutionBundles({
      caseIds: ["a"],
      affinities: [
        { id: "left", caseIds: ["a"] },
        { id: "right", caseIds: ["a"] },
      ],
    }),
  /belongs to multiple fixture affinities/,
);

assert.throws(
  () =>
    buildExecutionBundles({
      caseIds: ["a"],
      affinities: [
        { id: "shared", caseIds: ["a"] },
        { id: "shared", caseIds: [] },
      ],
    }),
  /Duplicate fixture affinity id/,
);

console.log("Execution bundle model checks passed.");
