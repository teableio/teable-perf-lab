export const PERFORMANCE_TRACK_IDENTITY_FIELDS = [
  { name: "Contract ID", type: "singleLineText", dbFieldName: "Contract_ID" },
  {
    name: "Environment Class",
    type: "singleLineText",
    dbFieldName: "Environment_Class",
  },
];

const identityString = (value) =>
  typeof value === "string" && value.trim() ? value : null;

export const extractMeasurementIdentity = (measurement) => ({
  contractId: identityString(measurement?.contract?.id),
  environmentClass: identityString(measurement?.environment?.class),
});

export const resolvePerformanceTrackIdentityColumns = (fields) => {
  if (!Array.isArray(fields)) {
    throw new Error("Invalid Performance Track field metadata: expected an array");
  }
  const columns = [];
  for (const expected of PERFORMANCE_TRACK_IDENTITY_FIELDS) {
    const matches = fields.filter((field) => field?.name === expected.name);
    if (matches.length !== 1) {
      throw new Error(
        `Performance Track schema requires exactly one ${expected.name} field; found ${matches.length}`,
      );
    }
    const [field] = matches;
    if (
      field.type !== expected.type ||
      field.isComputed ||
      field.isLookup ||
      typeof field.dbFieldName !== "string" ||
      !field.dbFieldName.trim() ||
      fields.some(
        (other) => other !== field && other?.dbFieldName === field.dbFieldName,
      )
    ) {
      throw new Error(
        `Incompatible Performance Track field ${expected.name}: expected noncomputed ${expected.type} with a unique nonempty dbFieldName; received type ${field.type}, dbFieldName ${field.dbFieldName}, isComputed ${Boolean(field.isComputed)}, isLookup ${Boolean(field.isLookup)}`,
      );
    }
    columns.push(field.dbFieldName);
  }
  return { contractId: columns[0], environmentClass: columns[1] };
};
