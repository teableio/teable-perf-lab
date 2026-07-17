import assert from "node:assert/strict";
import {
  assertConfigShape,
  buildHostBaseFieldModels,
  buildHostRecordFields,
  buildSourceFieldModels,
  buildSourceRecordFields,
  compileExpression,
  getExpectedValue,
  getFormulaExpression,
  getProjectionFieldNames,
  getSourceFieldNames,
  parseRowNumberFromTitle,
  resolveFieldIds,
  valuesMatch,
} from "../framework/runners/record-read-model.ts";

const config = {
  baseId: "base",
  sourceTableNamePrefix: "source",
  tableNamePrefix: "host",
  rowCount: 10_000,
  batchSize: 1_000,
  pageSize: 1_000,
  skip: 0,
  simpleTextFieldCount: 35,
  formulaFieldCount: 5,
  lookupFieldCount: 5,
  generator: {
    titlePrefix: "title",
    textPrefix: "text",
    sourceKeyPrefix: "src",
    sourceValuePrefix: "value",
    permutation: { multiplier: 37, offset: 11 },
  },
  verify: { sampleRows: [0, 4999, 9999] },
  threshold: { metric: "getRecordsPagedScanMs", maxMs: 30_000 },
};

assertConfigShape(config);
assertConfigShape({
  ...config,
  queryVariant: {
    filters: {
      conjunction: "and",
      items: [{ fieldName: "A", operator: "isGreater", value: 5_000 }],
    },
    orderBy: [{ fieldName: "A", order: "desc" }],
    expectedRowCount: 5_000,
  },
});
assert.equal(getSourceFieldNames(config).length, 6);
assert.equal(getProjectionFieldNames(config).length, 50);

assert.deepEqual(buildSourceFieldModels(config).slice(0, 2), [
  { name: "Source Key", type: "singleLineText" },
  { name: "Source Value 1", type: "singleLineText" },
]);
assert.deepEqual(buildHostBaseFieldModels(config).slice(0, 5), [
  { name: "Title", type: "singleLineText" },
  { name: "Lookup Source Key", type: "singleLineText" },
  { name: "A", type: "number" },
  { name: "B", type: "number" },
  { name: "C", type: "number" },
]);

assert.deepEqual(buildSourceRecordFields(12, config), {
  "Source Key": "src-00012",
  "Source Value 1": "value-1-00012",
  "Source Value 2": "value-2-00012",
  "Source Value 3": "value-3-00012",
  "Source Value 4": "value-4-00012",
  "Source Value 5": "value-5-00012",
});

assert.deepEqual(buildHostRecordFields(12, config), {
  Title: "title-00012",
  "Lookup Source Key": "src-00419",
  A: 12,
  B: 12,
  C: 5,
  "Text 1": "text-1-00012",
  "Text 2": "text-2-00012",
  "Text 3": "text-3-00012",
  "Text 4": "text-4-00012",
  "Text 5": "text-5-00012",
  "Text 6": "text-6-00012",
  "Text 7": "text-7-00012",
  "Text 8": "text-8-00012",
  "Text 9": "text-9-00012",
  "Text 10": "text-10-00012",
  "Text 11": "text-11-00012",
  "Text 12": "text-12-00012",
  "Text 13": "text-13-00012",
  "Text 14": "text-14-00012",
  "Text 15": "text-15-00012",
  "Text 16": "text-16-00012",
  "Text 17": "text-17-00012",
  "Text 18": "text-18-00012",
  "Text 19": "text-19-00012",
  "Text 20": "text-20-00012",
  "Text 21": "text-21-00012",
  "Text 22": "text-22-00012",
  "Text 23": "text-23-00012",
  "Text 24": "text-24-00012",
  "Text 25": "text-25-00012",
  "Text 26": "text-26-00012",
  "Text 27": "text-27-00012",
  "Text 28": "text-28-00012",
  "Text 29": "text-29-00012",
  "Text 30": "text-30-00012",
  "Text 31": "text-31-00012",
  "Text 32": "text-32-00012",
  "Text 33": "text-33-00012",
  "Text 34": "text-34-00012",
  "Text 35": "text-35-00012",
});

assert.equal(getExpectedValue("Title", 12, config), "title-00012");
assert.equal(getExpectedValue("Lookup Source Key", 12, config), "src-00419");
assert.equal(getExpectedValue("Formula 1", 12, config), 29);
assert.deepEqual(getExpectedValue("Lookup Value 2", 12, config), [
  "value-2-00419",
]);
assert.equal(parseRowNumberFromTitle("title-00012", config), 12);
assert.equal(valuesMatch(12, "12"), true);
assert.equal(valuesMatch(["value"], ["value"]), true);
assert.equal(getFormulaExpression(4), "({A} * 3) + ({B} * 5) + ({C} * 7)");
assert.equal(
  compileExpression("{A} + {Missing}", new Map([["A", "fldA"]])),
  "{fldA} + {Missing}",
);
assert.deepEqual(
  [
    ...resolveFieldIds(
      [
        { id: "fldA", name: "A" },
        { id: "fldB", name: "B" },
      ],
      ["A", "B"],
      "tbl",
    ),
  ],
  [
    ["A", "fldA"],
    ["B", "fldB"],
  ],
);

assert.throws(
  () => assertConfigShape({ ...config, simpleTextFieldCount: 34 }),
  /must project exactly 50 fields/,
);
assert.throws(
  () => assertConfigShape({ ...config, pageSize: 1_001 }),
  /exceeds the getRecords max of 1000/,
);
assert.throws(
  () => assertConfigShape({ ...config, rowCount: 9_999, pageSize: 1_000 }),
  /must be divisible by pageSize/,
);
assert.throws(
  () =>
    assertConfigShape({
      ...config,
      generator: {
        ...config.generator,
        permutation: { multiplier: 20, offset: 0 },
      },
    }),
  /must be coprime/,
);
assert.throws(
  () =>
    assertConfigShape({
      ...config,
      queryVariant: { expectedRowCount: 10_000 },
    }),
  /must define at least one clause/,
);
assert.throws(
  () =>
    assertConfigShape({
      ...config,
      queryVariant: {
        orderBy: [{ fieldName: "Missing", order: "asc" }],
        expectedRowCount: 10_000,
      },
    }),
  /missing projection field Missing/,
);
assert.throws(
  () =>
    assertConfigShape({
      ...config,
      queryVariant: {
        groupBy: [{ fieldName: "Formula 1", order: "asc" }],
        expectedRowCount: 10_000,
      },
    }),
  /groupBy field must be a stored host field/,
);
assert.throws(
  () =>
    assertConfigShape({
      ...config,
      queryVariant: {
        orderBy: [{ fieldName: "A", order: "asc" }],
        expectedRowCount: 10_001,
      },
    }),
  /expectedRowCount must be between/,
);
assert.throws(
  () => parseRowNumberFromTitle("wrong-00012", config),
  /Unexpected title value/,
);
assert.throws(
  () => getExpectedValue("Unknown", 12, config),
  /No expected value rule/,
);
assert.throws(
  () => resolveFieldIds([{ id: "fldA", name: "A" }], ["A", "B"], "tbl"),
  /Missing fields/,
);

console.log("Record-read model checks ok");
