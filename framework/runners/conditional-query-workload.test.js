import assert from "node:assert/strict";
import test from "node:test";
import { createConditionalQueryWorkload } from "./conditional-query-workload.ts";

const baseConfig = {
  baseId: "seed-base",
  sourceTableNamePrefix: "source",
  hostTableNamePrefix: "host",
  sourceRecordCount: 12,
  hostRecordCount: 6,
  groupCount: 3,
  batchSize: 6,
  generator: {
    type: "grouped-fanout",
    groupPrefix: "Group",
    sourceTextPrefix: "Value",
    hostKeyPrefix: "Host",
    permutation: { multiplier: 2, offset: 1 },
  },
  verify: { sampleRows: [0, 5] },
};

test("owns deterministic grouped seed and host permutation semantics", () => {
  const workload = createConditionalQueryWorkload({
    ...baseConfig,
    field: {
      name: "Values",
      kind: "lookup",
      valueField: "text",
      filter: "group",
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 1_000 },
  });

  assert.deepEqual(workload.sourceRow(1).fields, {
    "A Group": "Group-1",
    "A Text": "Value-1-1",
    "A Amount": 101,
    "A Active": true,
  });
  assert.deepEqual(workload.sourceRow(4).fields, {
    "A Group": "Group-1",
    "A Text": "Value-1-2",
    "A Amount": 102,
    "A Active": false,
  });
  assert.deepEqual(workload.hostRow(1).fields, {
    "B Key": "Host-1",
    "Lookup Group": "Group-2",
  });
  assert.deepEqual(workload.expectedValue(1, "seed"), [
    "Value-2-1",
    "Value-2-2",
    "Value-2-3",
    "Value-2-4",
  ]);
  assert.deepEqual(workload.shape("seed"), {
    fanout: 4,
    groupMatchesPerHost: 4,
    retainedValuesPerHost: 4,
    groupMatchPairCount: 24,
    retainedValueCount: 24,
  });
});

test("keeps filter, sort, limit, and rollup expectations in one model", () => {
  const workload = createConditionalQueryWorkload({
    ...baseConfig,
    field: {
      name: "Amount",
      kind: "rollup",
      valueField: "amount",
      expression: "sum({values})",
      filter: "group-and-active",
      sort: { field: "amount", order: "desc" },
      limit: 1,
    },
    threshold: { metric: "conditionalQueryReadyMs", maxMs: 1_000 },
  });

  assert.equal(workload.expectedValue(1, "seed"), 203);
  assert.equal(workload.shape("seed").retainedValuesPerHost, 1);
});

test("models text mutation targets, values, and scan extent", () => {
  const workload = createConditionalQueryWorkload({
    ...baseConfig,
    field: {
      name: "Values",
      kind: "lookup",
      valueField: "text",
      filter: "group",
    },
    mutation: {
      kind: "text-update",
      recordCount: 6,
      updatedSuffix: "updated",
    },
    threshold: {
      metric: "conditionalQueryPropagationReadyMs",
      maxMs: 1_000,
    },
  });

  assert.deepEqual(workload.sourcePosition(4), {
    group: 1,
    slot: 2,
    mutationTarget: true,
  });
  assert.equal(workload.mutation?.recordsPerGroup, 2);
  assert.equal(workload.mutation?.scanRows, 6);
  assert.deepEqual(
    workload.mutation?.fields(
      { group: "group", text: "text", amount: "amount", active: "active" },
      { recordId: "rec", group: 1, slot: 2 },
      "mutated",
    ),
    { text: "Value-1-2-updated" },
  );
  assert.deepEqual(workload.expectedValue(1, "mutated"), [
    "Value-2-1-updated",
    "Value-2-2-updated",
    "Value-2-3",
    "Value-2-4",
  ]);
});

test("models amount and active mutations without runtime services", () => {
  const amount = createConditionalQueryWorkload({
    ...baseConfig,
    field: {
      name: "Amount",
      kind: "rollup",
      valueField: "amount",
      expression: "sum({values})",
      filter: "group",
    },
    mutation: { kind: "amount-update", recordCount: 3, amountDelta: 10 },
    threshold: {
      metric: "conditionalQueryPropagationReadyMs",
      maxMs: 1_000,
    },
  });
  assert.equal(amount.expectedValue(1, "seed"), 810);
  assert.equal(amount.expectedValue(1, "mutated"), 820);

  const active = createConditionalQueryWorkload({
    ...baseConfig,
    field: {
      name: "Values",
      kind: "lookup",
      valueField: "text",
      filter: "group-and-active",
    },
    mutation: { kind: "active-flip", recordCount: 3 },
    threshold: {
      metric: "conditionalQueryPropagationReadyMs",
      maxMs: 1_000,
    },
  });
  assert.deepEqual(active.expectedValue(1, "seed"), ["Value-2-1", "Value-2-3"]);
  assert.deepEqual(active.expectedValue(1, "mutated"), ["Value-2-3"]);
  assert.equal(active.mutation?.scanRows, 3);
});

test("rejects invalid workload combinations before any Teable call", () => {
  assert.throws(
    () =>
      createConditionalQueryWorkload({
        ...baseConfig,
        sourceRecordCount: 10,
        field: {
          name: "Values",
          kind: "lookup",
          valueField: "text",
          filter: "group",
        },
        threshold: { metric: "conditionalQueryReadyMs", maxMs: 1_000 },
      }),
    /integral fanout/,
  );
  assert.throws(
    () =>
      createConditionalQueryWorkload({
        ...baseConfig,
        field: {
          name: "Amount",
          kind: "rollup",
          valueField: "amount",
          expression: "sum\({values}\)",
          filter: "group",
        },
        mutation: {
          kind: "text-update",
          recordCount: 3,
          updatedSuffix: "updated",
        },
        threshold: {
          metric: "conditionalQueryPropagationReadyMs",
          maxMs: 1_000,
        },
      }),
    /Text mutation requires a text lookup field/,
  );
});
