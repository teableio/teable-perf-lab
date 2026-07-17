import assert from "node:assert/strict";
import test from "node:test";
import {
  getRecordCreateExpectedValue,
  getRecordCreateSeedConfig,
  getRecordCreateSeedIdentityCase,
  projectRecordCreatePayloads,
  selectRecordCreatePayloadFields,
} from "./record-create-model.ts";

const fields = [
  { id: "fldTitle", name: "Title" },
  { id: "fldAmount", name: "Amount" },
  { id: "fldStatus", name: "Status" },
];

test("record create payload defaults to every field", () => {
  assert.deepEqual(selectRecordCreatePayloadFields(fields), fields);
});

test("record create payload preserves requested field order", () => {
  assert.deepEqual(
    selectRecordCreatePayloadFields(fields, ["Status", "Title"]),
    [fields[2], fields[0]],
  );
});

test("record create payload rejects empty, duplicate, and unknown fields", () => {
  assert.throws(
    () => selectRecordCreatePayloadFields(fields, []),
    /at least one field/,
  );
  assert.throws(
    () => selectRecordCreatePayloadFields(fields, ["Title", "Title"]),
    /must be unique/,
  );
  assert.throws(
    () => selectRecordCreatePayloadFields(fields, ["Missing"]),
    /Missing record create payload field Missing/,
  );
});

test("record create payload projection omits unselected cells", () => {
  const records = [
    { fields: { Title: "Row 1", Amount: 7, Status: "Todo" } },
    { fields: { Title: "Row 2", Amount: 14, Status: "Done" } },
  ];
  assert.deepEqual(projectRecordCreatePayloads(records, [fields[1]]), [
    { fields: { Amount: 7 } },
    { fields: { Amount: 14 } },
  ]);
});

test("omitted fields expect an empty created cell", () => {
  assert.equal(getRecordCreateExpectedValue("Amount", 7, ["Title"]), null);
  assert.equal(
    getRecordCreateExpectedValue("Title", "Row 1", ["Title"]),
    "Row 1",
  );
  assert.equal(getRecordCreateExpectedValue("Amount", 7), 7);
});

test("payload selection does not change a shared seed identity", () => {
  const baseConfig = {
    baseId: "seed-base",
    tableNamePrefix: "table-a",
    rowCount: 1_000,
    fields: [{ name: "Title", type: "singleLineText" }],
    seedIdentity: "mixed-1k-20fields",
    generator: {
      type: "mixed-record-create",
      titlePrefix: "Mixed row",
      payloadPrefix: "mixed",
      valuePrefix: "Cell",
    },
    verify: { sampleRows: [0, 499, 999] },
    threshold: { metric: "bulkCreate1kMs", maxMs: 6_000 },
  };
  const first = { ...baseConfig, createFieldNames: ["Title"] };
  const second = { ...baseConfig, createFieldNames: undefined };

  assert.deepEqual(
    getRecordCreateSeedConfig(first),
    getRecordCreateSeedConfig(second),
  );
  assert.equal(
    getRecordCreateSeedIdentityCase(
      { id: "record-create/a" },
      baseConfig.seedIdentity,
    ).id,
    getRecordCreateSeedIdentityCase(
      { id: "record-create/b" },
      baseConfig.seedIdentity,
    ).id,
  );
});
