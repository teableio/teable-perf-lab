import type { PerfCase, RecordUpdateCaseConfig } from "../types";

export const RECORD_UPDATE_FIXTURE_VERSION = "record-update-v1";

export const selectRecordUpdatePayloadFields = <T extends { name: string }>(
  fields: T[],
  updateFieldNames?: string[],
): T[] => {
  const requestedNames = updateFieldNames ?? fields.map((field) => field.name);
  if (requestedNames.length === 0) {
    throw new Error("record update payload must include at least one field");
  }
  if (new Set(requestedNames).size !== requestedNames.length) {
    throw new Error(
      `record update payload field names must be unique: ${requestedNames.join(
        ", ",
      )}`,
    );
  }

  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return requestedNames.map((name) => {
    const field = fieldByName.get(name);
    if (!field) {
      throw new Error(
        `Missing record update payload field ${name}; available fields: ${fields
          .map((item) => item.name)
          .join(", ")}`,
      );
    }
    return field;
  });
};

export const getRecordUpdateExpectedPhase = (
  fieldName: string,
  phase: "seed" | "updated",
  updateFieldNames?: string[],
) =>
  phase === "updated" &&
  updateFieldNames != null &&
  !updateFieldNames.includes(fieldName)
    ? "seed"
    : phase;

export const getRecordUpdateSeedConfig = (config: RecordUpdateCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: RECORD_UPDATE_FIXTURE_VERSION,
});

export const getRecordUpdateSeedIdentityCase = (
  perfCase: PerfCase,
  seedIdentity?: string,
) =>
  seedIdentity
    ? ({
        ...perfCase,
        id: `record-update/shared-${seedIdentity}`,
      } as PerfCase)
    : perfCase;
