import assert from "node:assert/strict";
import {
  chunkPerfCaseWriteRecords,
  DEFAULT_PERF_CASE_WRITE_MAX_BYTES,
  syncPerfCaseRecords,
} from "./perf-case-sync-model.mjs";

const desired = (caseId, title = caseId) => ({
  caseId,
  fields: {
    "Case ID": caseId,
    Title: title,
    Tags: ["lookup", "v2"],
    Enabled: true,
    Runner: "example",
    "Source SHA": "new-sha",
    "Synced At": "2026-07-17T06:00:00.000Z",
  },
});

const existing = (id, row, overrides = {}) => ({
  id,
  fields: {
    ...row.fields,
    "Source SHA": "old-sha",
    "Synced At": "2026-07-16T06:00:00.000Z",
    ...overrides,
  },
});

const writeBodyBytes = (records) =>
  Buffer.byteLength(
    JSON.stringify({ fieldKeyType: "name", typecast: true, records }),
  );

const createAdapter = (records) => {
  const calls = { list: 0, update: [], create: [] };
  return {
    calls,
    adapter: {
      async listRecords() {
        calls.list += 1;
        return records;
      },
      async updateRecords(value) {
        calls.update.push(value);
      },
      async createRecords(value) {
        calls.create.push(value);
        return value.map((_, index) => ({ id: `rec-created-${index + 1}` }));
      },
    },
  };
};

{
  const records = [
    { fields: { "Case ID": "case-one", Title: "one" } },
    { fields: { "Case ID": "case-two", Title: "two" } },
    { fields: { "Case ID": "case-three", Title: "three" } },
  ];
  const maxBytes = writeBodyBytes(records.slice(0, 2));
  const batches = chunkPerfCaseWriteRecords(records, maxBytes);

  assert.deepEqual(batches, [records.slice(0, 2), records.slice(2)]);
  assert.ok(batches.every((batch) => writeBodyBytes(batch) <= maxBytes));
  assert.equal(DEFAULT_PERF_CASE_WRITE_MAX_BYTES, 512 * 1024);

  await assert.rejects(
    async () =>
      chunkPerfCaseWriteRecords([records[0]], writeBodyBytes([records[0]]) - 1),
    /Perf case write record case-one exceeds/,
  );
}

{
  const rows = Array.from({ length: 111 }, (_, index) =>
    desired(`case-${index + 1}`),
  );
  const { adapter, calls } = createAdapter(
    rows.map((row, index) => existing(`rec-${index + 1}`, row)),
  );

  const result = await syncPerfCaseRecords({ adapter, desiredRecords: rows });

  assert.equal(calls.list, 1, "the full registry should be read once");
  assert.equal(
    calls.update.length,
    0,
    "metadata-only drift must not be written",
  );
  assert.equal(calls.create.length, 0);
  assert.equal(result.unchanged.length, 111);
  assert.equal(result.updated.length, 0);
  assert.equal(result.created.length, 0);
}

{
  const unchanged = desired("case-unchanged");
  const changed = desired("case-changed", "New title");
  const missing = desired("case-missing");
  const { adapter, calls } = createAdapter([
    existing("rec-unchanged", unchanged),
    existing("rec-changed", changed, { Title: "Old title" }),
  ]);

  const result = await syncPerfCaseRecords({
    adapter,
    desiredRecords: [unchanged, changed, missing],
  });

  assert.equal(calls.list, 1);
  assert.deepEqual(calls.update, [
    [{ id: "rec-changed", fields: changed.fields }],
  ]);
  assert.deepEqual(calls.create, [[{ fields: missing.fields }]]);
  assert.deepEqual(
    result.updated.map((item) => item.caseId),
    ["case-changed"],
  );
  assert.deepEqual(result.updated[0].changedFields, ["Title"]);
  assert.deepEqual(
    result.created.map((item) => [item.caseId, item.recordId]),
    [["case-missing", "rec-created-1"]],
  );
  assert.deepEqual(
    result.unchanged.map((item) => item.caseId),
    ["case-unchanged"],
  );
}

{
  const duplicate = desired("duplicate-case");
  const { adapter, calls } = createAdapter([]);

  await assert.rejects(
    syncPerfCaseRecords({
      adapter,
      desiredRecords: [duplicate, duplicate],
    }),
    /Duplicate desired Case ID: duplicate-case/,
  );
  assert.equal(calls.list, 0, "invalid desired input must fail before API I/O");
}

{
  const row = desired("duplicate-existing");
  const { adapter, calls } = createAdapter([
    existing("rec-first", row),
    existing("rec-second", row),
  ]);

  await assert.rejects(
    syncPerfCaseRecords({ adapter, desiredRecords: [row] }),
    /Duplicate existing Case ID: duplicate-existing/,
  );
  assert.equal(calls.update.length, 0);
  assert.equal(calls.create.length, 0);
}

console.log("Perf case sync model checks passed.");
