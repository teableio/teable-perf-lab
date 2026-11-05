import assert from "node:assert/strict";
import { planPerformanceTrackSchema } from "./performance-track-schema-model.mjs";
import { PERFORMANCE_TRACK_CONTRACT_FIELDS } from "./performance-track-contract.fixture.mjs";
import {
  extractMeasurementIdentity,
  resolvePerformanceTrackIdentityColumns,
} from "./performance-track-identity.mjs";

const measurementFields = [
  { name: "Measurement JSON", type: "longText" },
  { name: "Contract ID", type: "singleLineText", dbFieldName: "Contract_ID" },
  {
    name: "Environment Class",
    type: "singleLineText",
    dbFieldName: "Environment_Class",
  },
];
assert.deepEqual(planPerformanceTrackSchema([]), {
  create: measurementFields,
  incompatible: [],
});
assert.deepEqual(planPerformanceTrackSchema(PERFORMANCE_TRACK_CONTRACT_FIELDS), {
  create: [], incompatible: [],
});
const generatedFields = measurementFields.map((field) =>
  field.dbFieldName ? { ...field, dbFieldName: `${field.dbFieldName}_generated` } : field,
);
assert.deepEqual(planPerformanceTrackSchema(generatedFields), {
  create: [], incompatible: [],
});
assert.deepEqual(resolvePerformanceTrackIdentityColumns(generatedFields), {
  contractId: "Contract_ID_generated",
  environmentClass: "Environment_Class_generated",
});

for (const name of ["Measurement JSON", "Contract ID", "Environment Class"]) {
  for (const conflict of [
    { type: "number" }, { type: undefined }, { isComputed: true }, { isLookup: true },
  ]) {
    const fields = measurementFields.map((field) =>
      field.name === name ? { ...field, ...conflict } : field,
    );
    assert.ok(planPerformanceTrackSchema(fields).incompatible.length > 0);
  }
}
for (const fields of [
  measurementFields.filter(({ name }) => name !== "Contract ID"),
  [...measurementFields, { ...measurementFields[1] }],
  measurementFields.map((field) => field.name === "Contract ID" ? { ...field, dbFieldName: "" } : field),
  measurementFields.map((field) => field.name === "Contract ID" ? { ...field, dbFieldName: undefined } : field),
  [...measurementFields, { name: "Other", dbFieldName: "Contract_ID" }],
]) {
  assert.throws(() => resolvePerformanceTrackIdentityColumns(fields), /Performance Track/);
}
assert.ok(planPerformanceTrackSchema([
  { name: "Other", type: "singleLineText", dbFieldName: "Contract_ID" },
]).incompatible.length > 0);
assert.ok(planPerformanceTrackSchema([
  ...measurementFields, { ...measurementFields[2] },
]).incompatible.length > 0);

assert.deepEqual(extractMeasurementIdentity({
  contract: { id: " Contract-A " }, environment: { class: "Local-X" },
}), { contractId: " Contract-A ", environmentClass: "Local-X" });
for (const measurement of [undefined, null, "{}", 123, false, [], {}]) {
  assert.deepEqual(extractMeasurementIdentity(measurement), {
    contractId: null, environmentClass: null,
  });
}
for (const value of [undefined, null, "", "   ", {}, [], 123, false]) {
  assert.deepEqual(extractMeasurementIdentity({
    contract: { id: value }, environment: { class: value },
  }), { contractId: null, environmentClass: null });
}
console.log("performance track schema model checks passed");
