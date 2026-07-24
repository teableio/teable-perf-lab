import assert from "node:assert/strict";
import { evaluateFullRunVerdict } from "./full-run-acceptance-model.mjs";

const targetedSuccess = evaluateFullRunVerdict({
  fullRun: false,
  executeConclusion: "success",
});
assert.equal(targetedSuccess.status, "success");
assert.deepEqual(targetedSuccess.failures, []);

const targetedFailure = evaluateFullRunVerdict({
  fullRun: false,
  executeConclusion: "failure",
});
assert.deepEqual(
  targetedFailure.failures.map(({ code }) => code),
  ["execute-job"],
);

const fullRunSuccess = evaluateFullRunVerdict({
  fullRun: true,
  executeConclusion: "success",
  seedAffinityOutcome: "success",
  resultAcceptanceOutcome: "success",
});
assert.equal(fullRunSuccess.status, "success");

const fullRunFailure = evaluateFullRunVerdict({
  fullRun: true,
  executeConclusion: "failure",
  seedAffinityOutcome: "failure",
  resultAcceptanceOutcome: "cancelled",
});
assert.deepEqual(
  fullRunFailure.failures.map(({ code }) => code),
  ["execute-job", "seed-affinity", "result-acceptance"],
);
assert.deepEqual(fullRunFailure.evidence, {
  executeConclusion: "failure",
  seedAffinityOutcome: "failure",
  resultAcceptanceOutcome: "cancelled",
});

assert.throws(
  () =>
    evaluateFullRunVerdict({
      fullRun: "true",
      executeConclusion: "success",
    }),
  /fullRun must be a boolean/,
);

console.log("Full-run acceptance model checks passed.");
