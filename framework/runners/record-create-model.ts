import type { PerfCase, RecordCreateCaseConfig } from "../types";

export const RECORD_CREATE_FIXTURE_VERSION = "record-create-v3";

export type RecordCreatePayload<T = unknown> = {
  fields: Record<string, T>;
};

export const selectRecordCreatePayloadFields = <T extends { name: string }>(
  fields: T[],
  createFieldNames?: string[],
): T[] => {
  const requestedNames = createFieldNames ?? fields.map((field) => field.name);
  if (requestedNames.length === 0) {
    throw new Error("record create payload must include at least one field");
  }
  if (new Set(requestedNames).size !== requestedNames.length) {
    throw new Error(
      `record create payload field names must be unique: ${requestedNames.join(
        ", ",
      )}`,
    );
  }

  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  return requestedNames.map((name) => {
    const field = fieldByName.get(name);
    if (!field) {
      throw new Error(
        `Missing record create payload field ${name}; available fields: ${fields
          .map((item) => item.name)
          .join(", ")}`,
      );
    }
    return field;
  });
};

export const projectRecordCreatePayloads = <T>(
  records: Array<RecordCreatePayload<T>>,
  fields: Array<{ name: string }>,
): Array<RecordCreatePayload<T>> =>
  records.map((record) => ({
    fields: Object.fromEntries(
      fields.map((field) => [field.name, record.fields[field.name]]),
    ),
  }));

export const getRecordCreateExpectedValue = <T>(
  fieldName: string,
  generatedValue: T,
  createFieldNames?: string[],
): T | null =>
  createFieldNames == null || createFieldNames.includes(fieldName)
    ? generatedValue
    : null;

export const getRecordCreateSeedConfig = (config: RecordCreateCaseConfig) => ({
  baseId: config.baseId,
  rowCount: config.rowCount,
  fields: config.fields,
  generator: config.generator,
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: RECORD_CREATE_FIXTURE_VERSION,
});

export const getRecordCreateSeedIdentityCase = (
  perfCase: PerfCase,
  seedIdentity?: string,
) =>
  seedIdentity
    ? ({
        ...perfCase,
        id: `record-create/shared-${seedIdentity}`,
      } as PerfCase)
    : perfCase;
