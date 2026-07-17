import { isDeepStrictEqual } from "node:util";

// These fields describe the last material row reconciliation. Updating them on
// every workflow run would turn an otherwise unchanged registry into 111 writes.
const VOLATILE_FIELD_NAMES = new Set(["Source SHA", "Synced At"]);

const assertUniqueDesiredCaseIds = (desiredRecords) => {
  const seen = new Set();
  for (const record of desiredRecords) {
    if (seen.has(record.caseId)) {
      throw new Error(`Duplicate desired Case ID: ${record.caseId}`);
    }
    seen.add(record.caseId);
  }
};

const stableFieldNamesChanged = (existingFields, desiredFields) =>
  Object.entries(desiredFields)
    .filter(
      ([name, value]) =>
        !VOLATILE_FIELD_NAMES.has(name) &&
        !isDeepStrictEqual(existingFields?.[name], value),
    )
    .map(([name]) => name);

export const buildPerfCaseSyncPlan = ({ desiredRecords, existingRecords }) => {
  assertUniqueDesiredCaseIds(desiredRecords);
  const desiredCaseIds = new Set(desiredRecords.map((record) => record.caseId));
  const existingByCaseId = new Map();

  for (const record of existingRecords) {
    const caseId = record.fields?.["Case ID"];
    if (!caseId || !desiredCaseIds.has(caseId)) {
      continue;
    }
    if (existingByCaseId.has(caseId)) {
      throw new Error(`Duplicate existing Case ID: ${caseId}`);
    }
    existingByCaseId.set(caseId, record);
  }

  const created = [];
  const updated = [];
  const unchanged = [];

  for (const desiredRecord of desiredRecords) {
    const existingRecord = existingByCaseId.get(desiredRecord.caseId);
    if (!existingRecord) {
      created.push(desiredRecord);
      continue;
    }

    const changedFields = stableFieldNamesChanged(
      existingRecord.fields,
      desiredRecord.fields,
    );
    if (changedFields.length > 0) {
      updated.push({
        ...desiredRecord,
        recordId: existingRecord.id,
        changedFields,
      });
      continue;
    }

    unchanged.push({
      ...desiredRecord,
      recordId: existingRecord.id,
    });
  }

  return { created, updated, unchanged };
};

export const syncPerfCaseRecords = async ({ adapter, desiredRecords }) => {
  assertUniqueDesiredCaseIds(desiredRecords);
  const existingRecords = await adapter.listRecords();
  const plan = buildPerfCaseSyncPlan({ desiredRecords, existingRecords });

  if (plan.updated.length > 0) {
    await adapter.updateRecords(
      plan.updated.map((record) => ({
        id: record.recordId,
        fields: record.fields,
      })),
    );
  }

  let createdRecords = [];
  if (plan.created.length > 0) {
    createdRecords = await adapter.createRecords(
      plan.created.map((record) => ({ fields: record.fields })),
    );
  }

  return {
    updated: plan.updated,
    unchanged: plan.unchanged,
    created: plan.created.map((record, index) => ({
      ...record,
      recordId: createdRecords?.[index]?.id,
    })),
  };
};
