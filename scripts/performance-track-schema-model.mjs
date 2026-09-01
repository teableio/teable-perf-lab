import { OPTIONAL_PERFORMANCE_TRACK_FIELDS } from "./performance-track-record-model.mjs";

export const planPerformanceTrackSchema = (fields = []) => {
  const existingByName = new Map(
    fields.filter((field) => field?.name).map((field) => [field.name, field]),
  );
  const create = [];
  const incompatible = [];

  for (const expected of OPTIONAL_PERFORMANCE_TRACK_FIELDS) {
    const existing = existingByName.get(expected.name);
    if (!existing) {
      create.push(expected);
      continue;
    }
    if (existing.type && existing.type !== expected.type) {
      incompatible.push({
        name: expected.name,
        expectedType: expected.type,
        actualType: existing.type,
      });
    }
  }

  return { create, incompatible };
};
