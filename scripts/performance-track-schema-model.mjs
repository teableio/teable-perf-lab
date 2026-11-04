import { PERFORMANCE_TRACK_MEASUREMENT_FIELDS } from "./performance-track-record-model.mjs";
import {
  PERFORMANCE_TRACK_IDENTITY_FIELDS,
  resolvePerformanceTrackIdentityColumns,
} from "./performance-track-identity.mjs";

export const planPerformanceTrackSchema = (fields = []) => {
  if (!Array.isArray(fields)) {
    throw new Error("Invalid Performance Track field metadata: expected an array");
  }
  const create = [];
  const incompatible = [];

  for (const expected of PERFORMANCE_TRACK_MEASUREMENT_FIELDS) {
    const matches = fields.filter((field) => field?.name === expected.name);
    if (matches.length === 0) {
      if (
        expected.dbFieldName &&
        fields.some((field) => field?.dbFieldName === expected.dbFieldName)
      ) {
        incompatible.push({
          name: expected.name,
          reason: `dbFieldName ${expected.dbFieldName} belongs to a different field`,
        });
      } else {
        create.push(expected);
      }
      continue;
    }
    const [existing] = matches;
    if (
      matches.length !== 1 ||
      existing.type !== expected.type ||
      existing.isComputed ||
      existing.isLookup
    ) {
      incompatible.push({
        name: expected.name,
        reason: `expected one noncomputed ${expected.type} field; found ${matches.length}, type ${existing.type}, isComputed ${Boolean(existing.isComputed)}, isLookup ${Boolean(existing.isLookup)}`,
      });
    }
  }

  // Validate actual column mappings too. Missing fields use their planned
  // definitions only for this validation; existing generated names are retained.
  if (incompatible.length === 0) {
    try {
      resolvePerformanceTrackIdentityColumns([
        ...fields,
        ...create.filter(({ name }) =>
          PERFORMANCE_TRACK_IDENTITY_FIELDS.some((field) => field.name === name),
        ),
      ]);
    } catch (error) {
      incompatible.push({ name: "identity columns", reason: error.message });
    }
  }
  return { create, incompatible };
};
