import assert from "node:assert/strict";
import {
  benjaminiHochbergAdjusted,
  buildPairedExecutionOrder,
  buildPairedPlan,
  evaluatePairedExperiment,
  pairedSamplesFromPayloads,
} from "./paired-experiment-model.mjs";

assert.throws(
  () =>
    buildPairedPlan({
      experimentId: "experiment-a",
      baseSha: "main",
      candidateSha: "b".repeat(40),
      perfLabSha: "c".repeat(40),
      caseFilter: "record-read/*",
      schemaSignature: "schema-a",
    }),
  /full immutable/,
);

assert.throws(
  () =>
    buildPairedPlan({
      experimentId: "experiment-a",
      baseSha: "a".repeat(40),
      candidateSha: "b".repeat(40),
      perfLabSha: "main",
      caseFilter: "record-read/*",
      caseIds: ["record-read/example"],
      schemaSignature: "schema-a",
    }),
  /perfLabSha must be a full immutable/,
);

assert.throws(
  () =>
    buildPairedPlan({
      experimentId: "experiment-a",
      baseSha: "a".repeat(40),
      candidateSha: "b".repeat(40),
      perfLabSha: "c".repeat(40),
      caseFilter: "record-read/example",
      caseIds: ["record-read/example"],
      schemaSignature: "schema-a",
      computedUpdateMode: "eventual",
    }),
  /computedUpdateMode/,
);
assert.throws(
  () =>
    buildPairedPlan({
      experimentId: "experiment-a",
      baseSha: "a".repeat(40),
      candidateSha: "b".repeat(40),
      perfLabSha: "c".repeat(40),
      caseFilter: "record-read/example",
      caseIds: ["record-read/example"],
      schemaSignature: "schema-a",
      sampleCount: 0,
    }),
  /sampleCount/,
);

const order = buildPairedExecutionOrder({ pairs: 10, seed: "experiment-a" });
assert.equal(order.length, 10);
assert.equal(order.filter((pair) => pair.order === "base-candidate").length, 5);
assert.equal(order.filter((pair) => pair.order === "candidate-base").length, 5);
assert.throws(
  () => buildPairedExecutionOrder({ pairs: 0 }),
  /positive integer/,
);

assert.deepEqual(
  benjaminiHochbergAdjusted([0.01, 0.04, 0.03]),
  [0.03, 0.04, 0.04],
);

const payload = ({
  caseId = "record-read/a",
  pair,
  variant,
  value,
  contract = "contract-a",
  result = "pass",
  cpuCanaryMs,
  databaseCanaryMs,
  pairOrder = "base-candidate",
  sampleIndex = 0,
}) => ({
  caseId,
  result,
  thresholds: [{ metric: "readMs", actual: value, max: 10_000, passed: true }],
  measurement: {
    contract: { id: contract },
    environment: {
      class: "runner:Linux:X64:postgres-e2e",
      fingerprint: "environment-a",
      cpuCanaryMs,
      databaseCanaryMs,
    },
    execution: {
      lane: "paired",
      experimentId: "experiment-a",
      pairId: pair,
      variant,
      pairOrder,
      sampleIndex,
      perfLabSha: "c".repeat(40),
      teableEeSha: variant === "base" ? "a".repeat(40) : "b".repeat(40),
      jobId: "paired-job",
      shardId: "paired-single-host",
    },
  },
});

{
  const result = evaluatePairedExperiment();
  assert.equal(result.status, "inconclusive");
  assert.equal(result.reason, "no-comparable-cases");
}

const experiment = ({ ratio, pairs = 10, caseId = "record-read/a" }) =>
  Array.from({ length: pairs }, (_, index) => {
    const pair = `pair-${index + 1}`;
    const base = 100 + (index % 3);
    const pairOrder = index % 2 ? "candidate-base" : "base-candidate";
    return [
      payload({
        caseId,
        pair,
        variant: "base",
        value: base,
        cpuCanaryMs: 10,
        databaseCanaryMs: 5,
        pairOrder,
        sampleIndex: index,
      }),
      payload({
        caseId,
        pair,
        variant: "candidate",
        value: base * ratio,
        cpuCanaryMs: 10.2,
        databaseCanaryMs: 5.1,
        pairOrder,
        sampleIndex: index,
      }),
    ];
  }).flat();

{
  const result = evaluatePairedExperiment({
    payloads: experiment({ ratio: 1 }),
    policy: { bootstrapResamples: 999, permutationResamples: 999 },
  });
  assert.equal(result.status, "pass");
  assert.equal(result.cases[0].status, "pass");
  assert.equal(result.cases[0].evidenceLevel, "no_regression_detected");
  assert.equal(result.cases[0].pairs, 10);
  assert.deepEqual(result.cases[0].identity.contractIds, ["contract-a"]);
  assert.deepEqual(result.cases[0].identity.pairOrders, [
    "base-candidate",
    "candidate-base",
  ]);
}

{
  const values = experiment({ ratio: 1, pairs: 11 });
  values.splice(1, 1);
  const result = evaluatePairedExperiment({
    payloads: values,
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].pairs, 10);
  assert.equal(result.cases[0].reason, "excluded-pairs");
}

{
  const values = experiment({ ratio: 1.2 });
  for (let index = 0; index < 5; index += 1) {
    for (const item of values.slice(index * 2, index * 2 + 2)) {
      item.measurement.contract.id = "contract-b";
      item.measurement.environment.class = "runner:Linux:ARM64:postgres-e2e";
      item.measurement.environment.fingerprint = "environment-b";
    }
  }
  const result = evaluatePairedExperiment({
    payloads: values,
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].reason, "incompatible-pair-cohort");
}

{
  const values = experiment({ ratio: 1 });
  values.push(structuredClone(values[0]));
  const grouped = pairedSamplesFromPayloads(values);
  assert.equal(grouped["record-read/a"].samples.length, 9);
  assert.equal(
    grouped["record-read/a"].excluded[0].reason,
    "duplicate-pair-variant",
  );
}

{
  const values = experiment({ ratio: 1 });
  values[1].measurement.environment.cpuCanaryMs = undefined;
  const result = evaluatePairedExperiment({
    payloads: values,
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].reason, "environment-control-unmeasured");
}

{
  const values = experiment({ ratio: 1 });
  for (const item of values) {
    item.measurement.execution.pairOrder = "base-candidate";
  }
  const result = evaluatePairedExperiment({
    payloads: values,
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].reason, "unbalanced-pair-order");
}

{
  const values = experiment({ ratio: 1 });
  for (const item of values) {
    item.measurement.environment.cpuCanaryMs = undefined;
  }
  const result = evaluatePairedExperiment({
    payloads: values,
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].reason, "environment-control-unmeasured");
}

{
  const values = experiment({ ratio: 1 });
  for (const item of values) {
    const candidate = item.measurement.execution.variant === "candidate";
    item.measurement.environment.cpuCanaryMs = candidate ? 13 : 10;
    item.measurement.environment.databaseCanaryMs = candidate ? 10 : 13;
  }
  const result = evaluatePairedExperiment({
    payloads: values,
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].environment.controls.cpu.status, "drifted");
  assert.equal(result.cases[0].environment.controls.database.status, "drifted");
}

{
  const values = experiment({ ratio: 1.2 });
  values[1].measurement.environment.fingerprint = "environment-b";
  const grouped = pairedSamplesFromPayloads(values);
  assert.equal(
    grouped["record-read/a"].excluded[0].reason,
    "environment-fingerprint-mismatch",
  );
}

{
  const result = evaluatePairedExperiment({
    payloads: experiment({ ratio: 1.2 }),
    policy: { bootstrapResamples: 999, permutationResamples: 999 },
  });
  assert.equal(result.status, "regression");
  assert.equal(result.cases[0].status, "regression");
  assert.equal(result.cases[0].evidenceLevel, "code_regression");
  assert.ok(result.cases[0].confidenceInterval[0] > 1.1);
  assert.ok(result.cases[0].adjustedPValue < 0.05);
}

{
  const result = evaluatePairedExperiment({
    payloads: experiment({ ratio: 1.05 }),
    policy: { bootstrapResamples: 999, permutationResamples: 999 },
  });
  assert.equal(result.status, "pass");
}

{
  const result = evaluatePairedExperiment({
    payloads: experiment({ ratio: 1.2, pairs: 4 }),
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].reason, "insufficient-pairs");
  assert.equal(result.cases[0].evidenceLevel, "inconclusive");
}

{
  const values = experiment({ ratio: 1.2 });
  values[1].measurement.contract.id = "contract-b";
  const grouped = pairedSamplesFromPayloads(values);
  assert.equal(grouped["record-read/a"].samples.length, 9);
  assert.equal(
    grouped["record-read/a"].excluded[0].reason,
    "contract-mismatch",
  );
}

{
  const values = experiment({ ratio: 1.2 });
  for (const item of values) {
    item.measurement.environment.cpuCanaryMs =
      item.measurement.execution.variant === "candidate" ? 15 : 10;
  }
  const result = evaluatePairedExperiment({
    payloads: values,
    policy: { bootstrapResamples: 99, permutationResamples: 99 },
  });
  assert.equal(result.status, "inconclusive");
  assert.equal(result.cases[0].reason, "environment-control-drift");
}

console.log("paired experiment model checks passed");
