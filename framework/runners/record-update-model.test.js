import assert from "node:assert/strict";
import test from "node:test";
import {
  getRecordUpdateExpectedPhase,
  getRecordUpdateSeedConfig,
  getRecordUpdateSeedIdentityCase,
  selectRecordUpdatePayloadFields,
} from "./record-update-model.ts";

const fields = [
  { id: "fldTitle", name: "Title" },
  { id: "fldAmount", name: "Amount" },
  { id: "fldStatus", name: "Status" },
];

test("record update payload defaults to every field", () => {
  assert.deepEqual(selectRecordUpdatePayloadFields(fields), fields);
});

test("record update payload preserves the requested field order", () => {
  assert.deepEqual(
    selectRecordUpdatePayloadFields(fields, ["Status", "Title"]),
    [fields[2], fields[0]],
  );
});

test("record update payload rejects empty, duplicate, and unknown fields", () => {
  assert.throws(
    () => selectRecordUpdatePayloadFields(fields, []),
    /at least one field/,
  );
  assert.throws(
    () => selectRecordUpdatePayloadFields(fields, ["Title", "Title"]),
    /must be unique/,
  );
  assert.throws(
    () => selectRecordUpdatePayloadFields(fields, ["Missing"]),
    /Missing record update payload field Missing/,
  );
});

test("omitted fields keep seed expectations after a partial update", () => {
  assert.equal(
    getRecordUpdateExpectedPhase("Amount", "updated", ["Title"]),
    "seed",
  );
  assert.equal(
    getRecordUpdateExpectedPhase("Title", "updated", ["Title"]),
    "updated",
  );
  assert.equal(getRecordUpdateExpectedPhase("Amount", "updated"), "updated");
  assert.equal(
    getRecordUpdateExpectedPhase("Amount", "seed", ["Title"]),
    "seed",
  );
});

test("payload selection does not change a shared seed identity", () => {
  const baseConfig = {
    baseId: "seed-base",
    tableNamePrefix: "table-a",
    rowCount: 1_000,
    batchSize: 1_000,
    fields: [{ name: "Title", type: "singleLineText" }],
    seedIdentity: "mixed-1k-20fields",
    generator: {
      type: "mixed-record-update",
      seedPrefix: "seed",
      updatePrefix: "updated",
    },
    verify: { sampleRows: [0, 499, 999] },
    threshold: { metric: "bulkUpdate1kMs", maxMs: 8_000 },
  };
  const first = { ...baseConfig, updateFieldNames: ["Title"] };
  const second = { ...baseConfig, updateFieldNames: undefined };

  assert.deepEqual(
    getRecordUpdateSeedConfig(first),
    getRecordUpdateSeedConfig(second),
  );
  assert.equal(
    getRecordUpdateSeedIdentityCase(
      { id: "record-update/a" },
      baseConfig.seedIdentity,
    ).id,
    getRecordUpdateSeedIdentityCase(
      { id: "record-update/b" },
      baseConfig.seedIdentity,
    ).id,
  );
});
