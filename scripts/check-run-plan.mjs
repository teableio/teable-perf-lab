import assert from "node:assert/strict";
import { buildCaseFilterKey, resolveRunPlan } from "./run-plan.mjs";

const hybridComputedCases =
  "computed-outbox/bullmq-pause-recovery-20k,computed-outbox/formula-chain-update-1k-depth4,computed-outbox/formula-chain-update-1k-depth8,computed-outbox/formula-chain-update-20k-depth4-backlog,computed-outbox/formula-chain-update-5001-depth2,computed-outbox/formula-backfill-20k,computed-outbox/observer-polling-ab-10k,lookup/dual-link-computed-first-link-4k,lookup/dual-link-computed-repoint-2k";

const assertThrowsMessage = (label, fn, expectedMessage) => {
  assert.throws(
    fn,
    (error) => {
      assert.equal(error?.message, expectedMessage, label);
      return true;
    },
    label,
  );
};

assert.deepEqual(
  resolveRunPlan({
    engineFilter: "v1,v2",
    caseFilter: "all",
    computedUpdateMode: "",
  }),
  {
    engines: ["v1", "v2"],
    caseFilterKey: "all",
    executePlan: [
      {
        name: "v1",
        engine: "v1",
        caseFilter: "all",
        excludeCaseFilter: "",
        computedUpdateMode: "",
        artifactSuffix: "v1",
        otelServiceSuffix: "v1",
      },
      {
        name: "v2-sync-default",
        engine: "v2",
        caseFilter: "all",
        excludeCaseFilter: hybridComputedCases,
        computedUpdateMode: "",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2-sync",
      },
      {
        name: "v2-hybrid-computed",
        engine: "v2",
        caseFilter: hybridComputedCases,
        excludeCaseFilter: "",
        computedUpdateMode: "hybrid",
        artifactSuffix: "v2-hybrid-computed",
        otelServiceSuffix: "v2-hybrid",
      },
    ],
  },
);

assert.deepEqual(
  resolveRunPlan({
    engineFilter: "v2",
    caseFilter: "all",
    computedUpdateMode: "hybrid",
  }),
  {
    engines: ["v2"],
    caseFilterKey: "all",
    executePlan: [
      {
        name: "v2",
        engine: "v2",
        caseFilter: "all",
        excludeCaseFilter: "",
        computedUpdateMode: "hybrid",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2",
      },
    ],
  },
);

assert.deepEqual(
  resolveRunPlan({
    engineFilter: " v2, v1, v2 ",
    caseFilter: " formula/10k-calc,smoke/auth-user ",
    computedUpdateMode: "",
  }),
  {
    engines: ["v2", "v1"],
    caseFilterKey: "formula-10k-calc__smoke-auth-user",
    executePlan: [
      {
        name: "v2",
        engine: "v2",
        caseFilter: " formula/10k-calc,smoke/auth-user ",
        excludeCaseFilter: "",
        computedUpdateMode: "",
        artifactSuffix: "v2",
        otelServiceSuffix: "v2",
      },
      {
        name: "v1",
        engine: "v1",
        caseFilter: " formula/10k-calc,smoke/auth-user ",
        excludeCaseFilter: "",
        computedUpdateMode: "",
        artifactSuffix: "v1",
        otelServiceSuffix: "v1",
      },
    ],
  },
);

assert.equal(
  buildCaseFilterKey("z/case,a/case,z/case," + "x".repeat(180)).length,
  160,
);

assertThrowsMessage(
  "empty engine list",
  () =>
    resolveRunPlan({
      engineFilter: " , ",
      caseFilter: "all",
    }),
  "engine_filter must include at least one engine.",
);

assertThrowsMessage(
  "invalid engine",
  () =>
    resolveRunPlan({
      engineFilter: "v1,v3",
      caseFilter: "all",
    }),
  "Unsupported engine_filter value(s): v3. Use v1, v2, or v1,v2.",
);

assertThrowsMessage(
  "empty case filter",
  () =>
    resolveRunPlan({
      engineFilter: "v1",
      caseFilter: " , ",
    }),
  "case_filter must include at least one case id or all.",
);

console.log("Run plan checks ok");
