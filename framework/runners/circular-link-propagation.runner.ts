import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import { updateRecords, updateTableDescription } from "@teable/openapi";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  getRecord,
  getRecords,
  getTable,
  permanentDeleteTable,
} from "../../../utils/init-app";
import { chunk } from "../chunk";
import {
  getPositiveIntegerEnv,
  getPrimaryThresholdMs,
  isExecuteDbIsolated,
} from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import {
  assertEngineRouting,
  pickRoutingResponseHeaders,
  type EngineRouting,
} from "../routing";
import {
  buildSeedCacheInfo,
  buildSeedTableName,
  findSeedTable,
  type SeedCacheInfo,
} from "../seed-cache";
import { pollUntilReady, sleep } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
import { withPerfTraceStep } from "../trace-collector";
import type {
  CircularLinkPropagationCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  COMPUTED_FIELD_COUNTS,
  FIELD_COUNTS,
  ORDER_ATTR_COUNT,
  ORDER_FORMULAS,
  ORDER_NUM_COUNT,
  ORDER_TEXT_COUNT,
  PLASMID_BACKBONE_FIELD,
  PLASMID_GRADE_FIELD,
  PLASMID_METRIC_COUNT,
  PLASMID_NOTE_COUNT,
  PLASMID_TOTAL_FIELD,
  PLASMID_TYPE_KEY_FIELD,
  PURIFICATION_BATCH_FIELD,
  PURIFICATION_EXPRESSION_FIELD,
  PURIFICATION_FORMULAS,
  PURIFICATION_METHOD_FIELD,
  PURIFICATION_NUM_COUNT,
  PURIFICATION_OPERATOR_FIELD,
  PURIFICATION_ORDER_LINK_FIELD,
  PURIFICATION_ORDER_LOOKUPS,
  PURIFICATION_PLASMID_LINK_FIELD,
  PURIFICATION_PLASMID_LOOKUPS,
  PURIFICATION_PURITY_FIELD,
  PURIFICATION_SELECT_COUNT,
  PURIFICATION_SUBORDER_LOOKUPS,
  PURIFICATION_TEXT_COUNT,
  PURIFICATION_YIELD_FIELD,
  SELECT_OPTIONS,
  SUBORDER_DATE_COUNT,
  SUBORDER_FORMULAS,
  SUBORDER_NUM_COUNT,
  SUBORDER_ORDER_LINK_FIELD,
  SUBORDER_ORDER_LOOKUPS,
  SUBORDER_PLASMID_CONDITIONAL_LOOKUPS,
  SUBORDER_PLASMID_LINK_FIELD,
  SUBORDER_PLASMID_TYPE_KEY_FIELD,
  SUBORDER_PURIFICATION_LINK_DUP_FIELD,
  SUBORDER_PURIFICATION_LINK_FIELD,
  SUBORDER_PURIFICATION_LOOKUPS,
  SUBORDER_SELECT_COUNT,
  SUBORDER_TEXT_COUNT,
  TITLE_FIELD,
  affectedSubOrderRows,
  expectedPurificationComputed,
  expectedSubOrderComputed,
  numberedField,
  orderAttr,
  orderNum,
  orderRowForPurification,
  orderRowForSubOrder,
  orderText,
  orderTitle,
  plasmidBackbone,
  plasmidGrade,
  plasmidMetric,
  plasmidNote,
  plasmidRowForPurification,
  plasmidRowForSubOrder,
  plasmidTitle,
  plasmidTotalAmount,
  plasmidTypeKey,
  purificationBatchCode,
  purificationMethod,
  purificationNum,
  purificationOperator,
  purificationPurity,
  purificationRowBySubOrderRow,
  purificationSelect,
  purificationText,
  purificationTitle,
  purificationYield,
  resolveMutationWindow,
  seedExpressionValue,
  subOrderDate,
  subOrderNum,
  subOrderPlasmidTypeKey,
  subOrderRowForPurification,
  subOrderSelect,
  subOrderText,
  subOrderTitle,
  updatedExpressionValue,
  type CircularLinkPhase,
  type ExpectedCell,
} from "./circular-link-propagation-workload";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const FIXTURE_VERSION = "circular-link-propagation-v1";
const METADATA_PREFIX = "perf-lab-circular-link-propagation:";

type NamedField = {
  id: string;
  name: string;
  type?: string;
  options?: { symmetricFieldId?: string; foreignTableId?: string };
};

type SeededRecord = { rowNumber: number; recordId: string };

type TableFieldIds = Record<string, string>;

type Fixture = {
  subOrdersTableId: string;
  subOrdersTableName: string;
  ordersTableId: string;
  purificationTableId: string;
  plasmidTableId: string;
  subOrderFields: TableFieldIds;
  purificationFields: TableFieldIds;
  purificationBackrefFieldId: string;
  purificationBackrefDupFieldId: string;
  subOrderRecords: SeededRecord[];
  purificationRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type PrimaryResult = {
  sourceUpdateMs: number;
  hostReadinessMs: number;
  cascadeVerificationMs: number;
  affectedSubOrderCount: number;
  requestedRecords: number;
  updatedRecords: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  subOrdersScan: {
    scannedRecords: number;
    pageSize: number;
    pageCount: number;
  };
  purificationScan: {
    scannedRecords: number;
    pageSize: number;
    pageCount: number;
  };
};

// Debug-only smoke overrides so a local run can validate mechanics at small
// scale without editing the committed case config. Unset in CI.
const applySmokeOverrides = (
  config: CircularLinkPropagationCaseConfig,
): CircularLinkPropagationCaseConfig => {
  const orders = getPositiveIntegerEnv("PERF_LAB_CLP_ORDER_ROWS");
  const subOrders = getPositiveIntegerEnv("PERF_LAB_CLP_SUBORDER_ROWS");
  const purifications = getPositiveIntegerEnv("PERF_LAB_CLP_PURIFICATION_ROWS");
  if (!orders && !subOrders && !purifications) {
    return config;
  }
  const subOrderRowCount = subOrders ?? config.subOrderRowCount;
  const purificationRowCount = Math.min(
    purifications ?? config.purificationRowCount,
    subOrderRowCount,
  );
  const recordCount = Math.min(
    config.mutation.recordCount,
    purificationRowCount,
  );
  return {
    ...config,
    orderRowCount: orders ?? config.orderRowCount,
    subOrderRowCount,
    purificationRowCount,
    mutation: {
      recordCount,
      startOffset: Math.min(
        config.mutation.startOffset ?? 0,
        purificationRowCount - recordCount,
      ),
    },
    verify: {
      ...config.verify,
      subOrderSampleRows: config.verify.subOrderSampleRows.filter(
        (offset) => offset < subOrderRowCount,
      ),
      purificationSampleRows: config.verify.purificationSampleRows.filter(
        (offset) => offset < purificationRowCount,
      ),
    },
  };
};

// ---------------------------------------------------------------------------
// Field construction (schema constants live in the workload model)
// ---------------------------------------------------------------------------

const textField = (name: string) => ({
  name,
  type: FieldType.SingleLineText,
});
const numberField = (name: string) => ({ name, type: FieldType.Number });
const selectField = (name: string) => ({
  name,
  type: FieldType.SingleSelect,
  options: { choices: SELECT_OPTIONS.map((option) => ({ name: option })) },
});
const dateField = (name: string) => ({
  name,
  type: FieldType.Date,
  options: {
    formatting: { date: "YYYY-MM-DD", time: "None", timeZone: "UTC" },
  },
});

const range = (count: number) =>
  Array.from({ length: count }, (_, index) => index + 1);

const plasmidPlainFields = () => [
  textField(TITLE_FIELD),
  textField(PLASMID_TYPE_KEY_FIELD),
  numberField(PLASMID_TOTAL_FIELD),
  textField(PLASMID_BACKBONE_FIELD),
  textField(PLASMID_GRADE_FIELD),
  ...range(PLASMID_NOTE_COUNT).map((i) =>
    textField(numberedField("pl_note", i)),
  ),
  ...range(PLASMID_METRIC_COUNT).map((i) =>
    numberField(numberedField("pl_metric", i)),
  ),
];

const orderPlainFields = () => [
  textField(TITLE_FIELD),
  ...range(ORDER_ATTR_COUNT).map((i) => textField(numberedField("o_attr", i))),
  ...range(ORDER_TEXT_COUNT).map((i) => textField(numberedField("o_text", i))),
  ...range(ORDER_NUM_COUNT).map((i) => numberField(numberedField("o_num", i))),
];

const subOrderPlainFields = () => [
  textField(TITLE_FIELD),
  textField(SUBORDER_PLASMID_TYPE_KEY_FIELD),
  ...range(SUBORDER_TEXT_COUNT).map((i) =>
    textField(numberedField("so_text", i)),
  ),
  ...range(SUBORDER_NUM_COUNT).map((i) =>
    numberField(numberedField("so_num", i)),
  ),
  ...range(SUBORDER_SELECT_COUNT).map((i) =>
    selectField(numberedField("so_select", i)),
  ),
  ...range(SUBORDER_DATE_COUNT).map((i) =>
    dateField(numberedField("so_date", i)),
  ),
];

const purificationPlainFields = () => [
  textField(TITLE_FIELD),
  numberField(PURIFICATION_EXPRESSION_FIELD),
  textField(PURIFICATION_BATCH_FIELD),
  textField(PURIFICATION_OPERATOR_FIELD),
  textField(PURIFICATION_METHOD_FIELD),
  numberField(PURIFICATION_PURITY_FIELD),
  numberField(PURIFICATION_YIELD_FIELD),
  ...range(PURIFICATION_TEXT_COUNT).map((i) =>
    textField(numberedField("p_text", i)),
  ),
  ...range(PURIFICATION_NUM_COUNT).map((i) =>
    numberField(numberedField("p_num", i)),
  ),
  ...range(PURIFICATION_SELECT_COUNT).map((i) =>
    selectField(numberedField("p_select", i)),
  ),
];

const lookupFieldType = (kind: "text" | "number" | "select" | "link") => {
  switch (kind) {
    case "number":
      return FieldType.Number;
    case "select":
      return FieldType.SingleSelect;
    case "link":
      return FieldType.Link;
    default:
      return FieldType.SingleLineText;
  }
};

const resolveNamedField = (fields: NamedField[], fieldName: string) => {
  const field = fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    throw new Error(
      `Missing field ${fieldName}; available: ${fields
        .map(({ name }) => name)
        .join(", ")}`,
    );
  }
  return field;
};

const fieldIdMap = (fields: NamedField[]): TableFieldIds =>
  Object.fromEntries(fields.map((field) => [field.name, field.id]));

const compileFormulaExpression = (
  expression: string,
  fieldIdByName: TableFieldIds,
) =>
  expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName[fieldName];
    return fieldId ? `{${fieldId}}` : match;
  });

// Lookup cells can surface either the scalar value or a single-element array
// depending on engine/cellFormat; link cells surface {id,title}. Normalize all
// shapes (same contract as link-computed-propagation).
const normalizeLookupValue = (value: unknown): string | null => {
  if (value == null) {
    return null;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return null;
    }
    if (value.length === 1) {
      return normalizeLookupValue(value[0]);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "object" && "title" in (value as object)) {
    const title = (value as { title?: unknown }).title;
    return typeof title === "string" ? title : JSON.stringify(value);
  }
  return typeof value === "string" ? value : String(value);
};

const isLookupFieldName = (name: string) =>
  name.startsWith("lu_") || name.startsWith("clu_");

const assertExpectedCell = (
  rowLabel: string,
  fieldName: string,
  raw: unknown,
  expected: ExpectedCell,
) => {
  if (expected.kind === "skip") {
    return;
  }
  if (expected.kind === "empty") {
    const actual = normalizeLookupValue(raw);
    if (actual !== null) {
      throw new Error(
        `${rowLabel} ${fieldName} expected empty, actual ${String(actual)}`,
      );
    }
    return;
  }
  if (isLookupFieldName(fieldName)) {
    const actual = normalizeLookupValue(raw);
    if (actual !== String(expected.value)) {
      throw new Error(
        `${rowLabel} ${fieldName} mismatch: expected ${String(expected.value)}, actual ${String(actual)}`,
      );
    }
    return;
  }
  if (typeof expected.value === "number") {
    if (raw == null || Number(raw) !== expected.value) {
      throw new Error(
        `${rowLabel} ${fieldName} mismatch: expected ${expected.value}, actual ${String(raw)}`,
      );
    }
    return;
  }
  if (raw !== expected.value) {
    throw new Error(
      `${rowLabel} ${fieldName} mismatch: expected ${expected.value}, actual ${String(raw)}`,
    );
  }
};

const assertComputedFields = (
  rowLabel: string,
  fields: Record<string, unknown>,
  fieldIds: TableFieldIds,
  expected: Record<string, ExpectedCell>,
) => {
  for (const [fieldName, expectation] of Object.entries(expected)) {
    const fieldId = fieldIds[fieldName];
    if (!fieldId) {
      throw new Error(`${rowLabel} has no field id for ${fieldName}`);
    }
    assertExpectedCell(rowLabel, fieldName, fields[fieldId], expectation);
  }
};

// ---------------------------------------------------------------------------
// Seed metadata (persisted in the SubOrders table description for cache reuse)
// ---------------------------------------------------------------------------

type CachedSeed = {
  fixtureVersion: string;
  orderRowCount: number;
  subOrderRowCount: number;
  purificationRowCount: number;
  plasmidRowCount: number;
  ordersTableId: string;
  purificationTableId: string;
  plasmidTableId: string;
  subOrderRecordIds: string[];
  purificationRecordIds: string[];
};

const parseCachedSeed = (
  description: string | null | undefined,
): CachedSeed | undefined => {
  if (!description?.startsWith(METADATA_PREFIX)) {
    return;
  }
  try {
    return JSON.parse(description.slice(METADATA_PREFIX.length)) as CachedSeed;
  } catch {
    return;
  }
};

const persistCachedSeed = async (
  baseId: string,
  subOrdersTableId: string,
  metadata: CachedSeed,
) => {
  await updateTableDescription(baseId, subOrdersTableId, {
    description: `${METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const getComputedSeedConfig = (config: CircularLinkPropagationCaseConfig) => ({
  baseId: config.baseId,
  orderRowCount: config.orderRowCount,
  subOrderRowCount: config.subOrderRowCount,
  purificationRowCount: config.purificationRowCount,
  plasmidRowCount: config.plasmidRowCount,
  batchSize: config.batchSize,
  purificationBatchSize: config.purificationBatchSize,
  orderPermutation: config.orderPermutation,
  purificationSubOrderPermutation: config.purificationSubOrderPermutation,
  purificationOrderPermutation: config.purificationOrderPermutation,
  fieldCounts: FIELD_COUNTS,
  computedFieldCounts: COMPUTED_FIELD_COUNTS,
  verifySubOrderSampleRows: config.verify.subOrderSampleRows,
  verifyPurificationSampleRows: config.verify.purificationSampleRows,
  fixtureVersion: FIXTURE_VERSION,
});

// ---------------------------------------------------------------------------
// Assertions over live rows
// ---------------------------------------------------------------------------

const subOrderProjection = (fixture: Fixture) => [
  fixture.subOrderFields[TITLE_FIELD]!,
  ...[
    ...SUBORDER_ORDER_LOOKUPS,
    ...SUBORDER_PLASMID_CONDITIONAL_LOOKUPS,
    ...SUBORDER_PURIFICATION_LOOKUPS,
  ].map((spec) => fixture.subOrderFields[spec.name]!),
  ...SUBORDER_FORMULAS.map((spec) => fixture.subOrderFields[spec.name]!),
];

const purificationProjection = (fixture: Fixture) => [
  fixture.purificationFields[TITLE_FIELD]!,
  ...[
    ...PURIFICATION_SUBORDER_LOOKUPS,
    ...PURIFICATION_PLASMID_LOOKUPS,
    ...PURIFICATION_ORDER_LOOKUPS,
  ].map((spec) => fixture.purificationFields[spec.name]!),
  ...PURIFICATION_FORMULAS.map(
    (spec) => fixture.purificationFields[spec.name]!,
  ),
];

const parseRowNumber = (prefix: string, value: unknown) => {
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`Expected "${prefix}<rowNumber>", got ${String(value)}`);
  }
  const rowNumber = Number(value.slice(prefix.length));
  if (!Number.isInteger(rowNumber)) {
    throw new Error(`Expected integer row number, got ${String(value)}`);
  }
  return rowNumber;
};

const assertSubOrderRow = (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  fields: Record<string, unknown>,
  subOrderRow: number,
  phase: CircularLinkPhase,
  purificationRow: number | undefined,
) =>
  assertComputedFields(
    `SubOrder ${subOrderRow}`,
    fields,
    fixture.subOrderFields,
    expectedSubOrderComputed(subOrderRow, config, phase, purificationRow),
  );

const assertPurificationRow = (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  fields: Record<string, unknown>,
  purificationRow: number,
  phase: CircularLinkPhase,
) =>
  assertComputedFields(
    `Purification ${purificationRow}`,
    fields,
    fixture.purificationFields,
    expectedPurificationComputed(purificationRow, config, phase),
  );

const assertSubOrderRecordById = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  subOrderRow: number,
  phase: CircularLinkPhase,
  purificationBySubOrder: Map<number, number>,
) => {
  const seeded = fixture.subOrderRecords[subOrderRow - 1];
  if (!seeded) {
    throw new Error(`Missing seeded SubOrder metadata for row ${subOrderRow}`);
  }
  const record = await getRecord(fixture.subOrdersTableId, seeded.recordId);
  if (!record) {
    throw new Error(`Missing SubOrder record ${seeded.recordId}`);
  }
  assertSubOrderRow(
    fixture,
    config,
    record.fields,
    subOrderRow,
    phase,
    purificationBySubOrder.get(subOrderRow),
  );
};

const assertPurificationRecordById = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  purificationRow: number,
  phase: CircularLinkPhase,
) => {
  const seeded = fixture.purificationRecords[purificationRow - 1];
  if (!seeded) {
    throw new Error(
      `Missing seeded Purification metadata for row ${purificationRow}`,
    );
  }
  const record = await getRecord(fixture.purificationTableId, seeded.recordId);
  if (!record) {
    throw new Error(`Missing Purification record ${seeded.recordId}`);
  }
  assertPurificationRow(fixture, config, record.fields, purificationRow, phase);
};

const assertSamples = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  phase: CircularLinkPhase,
) => {
  const purificationBySubOrder = purificationRowBySubOrderRow(config);
  let checkedRecords = 0;
  for (const offset of config.verify.subOrderSampleRows) {
    await assertSubOrderRecordById(
      fixture,
      config,
      offset + 1,
      phase,
      purificationBySubOrder,
    );
    checkedRecords += 1;
  }
  for (const offset of config.verify.purificationSampleRows) {
    await assertPurificationRecordById(fixture, config, offset + 1, phase);
    checkedRecords += 1;
  }
  return { checkedRecords };
};

const waitForSamples = (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  phase: CircularLinkPhase,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 300_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 250,
      description: `circular-link ${phase} samples`,
    },
    () => assertSamples(fixture, config, phase),
  );

// Primary readiness: every affected SubOrder row must expose the complete
// post-update lookup + formula state through the real read path.
const assertAffectedSubOrders = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  context: PerfRunContext,
  purificationBySubOrder: Map<number, number>,
) => {
  if (context.signal?.aborted) {
    throw new Error("aborted while reading affected sub-orders");
  }
  let checkedRecords = 0;
  for (const subOrderRow of affectedSubOrderRows(config)) {
    await assertSubOrderRecordById(
      fixture,
      config,
      subOrderRow,
      "updated",
      purificationBySubOrder,
    );
    checkedRecords += 1;
  }
  return { checkedRecords };
};

const assertSubOrdersFullScan = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  phase: CircularLinkPhase,
  purificationBySubOrder: Map<number, number>,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const projection = subOrderProjection(fixture);
  const seen = new Set<number>();
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.subOrderRowCount,
      pageSize,
      pageNoun: "sub-orders",
      fetchPage: (skip, take) =>
        getRecords(fixture.subOrdersTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection,
          skip,
          take,
        }),
    },
    (record) => {
      const subOrderRow = parseRowNumber(
        "SubOrder ",
        record.fields[fixture.subOrderFields[TITLE_FIELD]!],
      );
      if (seen.has(subOrderRow)) {
        throw new Error(`Duplicate sub-order row in scan: ${subOrderRow}`);
      }
      seen.add(subOrderRow);
      assertSubOrderRow(
        fixture,
        config,
        record.fields,
        subOrderRow,
        phase,
        purificationBySubOrder.get(subOrderRow),
      );
    },
  );
  if (scannedRecords !== config.subOrderRowCount) {
    throw new Error(
      `Sub-orders scan count mismatch: expected ${config.subOrderRowCount}, scanned ${scannedRecords}`,
    );
  }
  return { scannedRecords, pageSize, pageCount };
};

const assertPurificationFullScan = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  phase: CircularLinkPhase,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const projection = purificationProjection(fixture);
  const seen = new Set<number>();
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.purificationRowCount,
      pageSize,
      pageNoun: "purifications",
      fetchPage: (skip, take) =>
        getRecords(fixture.purificationTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection,
          skip,
          take,
        }),
    },
    (record) => {
      const purificationRow = parseRowNumber(
        "Purification ",
        record.fields[fixture.purificationFields[TITLE_FIELD]!],
      );
      if (seen.has(purificationRow)) {
        throw new Error(
          `Duplicate purification row in scan: ${purificationRow}`,
        );
      }
      seen.add(purificationRow);
      assertPurificationRow(
        fixture,
        config,
        record.fields,
        purificationRow,
        phase,
      );
    },
  );
  if (scannedRecords !== config.purificationRowCount) {
    throw new Error(
      `Purification scan count mismatch: expected ${config.purificationRowCount}, scanned ${scannedRecords}`,
    );
  }
  return { scannedRecords, pageSize, pageCount };
};

// The circle-closing proof: both hosts fully re-readable, including
// Purification's reverse lookup of the SubOrders formula that consumed the
// edited cell. Runs OUTSIDE the primary metric.
const waitForFullCascade = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  phase: CircularLinkPhase,
  context: PerfRunContext,
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 300_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 250;
  const purificationBySubOrder = purificationRowBySubOrderRow(config);
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    if (context.signal?.aborted) {
      throw new Error("aborted while waiting for the circular cascade");
    }
    try {
      const subOrdersScan = await assertSubOrdersFullScan(
        fixture,
        config,
        phase,
        purificationBySubOrder,
      );
      const purificationScan = await assertPurificationFullScan(
        fixture,
        config,
        phase,
      );
      return { subOrdersScan, purificationScan };
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(
    `Timed out waiting for the circular cascade after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

// ---------------------------------------------------------------------------
// Fixture build / restore
// ---------------------------------------------------------------------------

const seedRecordsInBatches = async (
  tableId: string,
  records: Array<Record<string, unknown>>,
  batchSize: number,
  fieldKeyType: FieldKeyType,
  seedBatchDurations: number[],
) => {
  const recordIds: string[] = [];
  for (const batch of chunk(records, batchSize)) {
    const batchMeasurement = await measureAsync("seedBatch", () =>
      createRecords(tableId, {
        fieldKeyType,
        typecast: true,
        records: batch.map((fields) => ({ fields })),
      }),
    );
    seedBatchDurations.push(batchMeasurement.durationMs);
    expect(batchMeasurement.result.records).toHaveLength(batch.length);
    for (const record of batchMeasurement.result.records) {
      recordIds.push(record.id);
    }
  }
  return recordIds;
};

const createLinkField = async (
  tableId: string,
  name: string,
  foreignTableId: string,
  relationship: Relationship,
  isOneWay: boolean,
) =>
  createField(tableId, {
    name,
    type: FieldType.Link,
    options: { relationship, foreignTableId, isOneWay },
  });

const createLookup = async (
  tableId: string,
  name: string,
  kind: "text" | "number" | "select" | "link",
  foreignTableId: string,
  linkFieldId: string,
  lookupFieldId: string,
) =>
  createField(tableId, {
    name,
    type: lookupFieldType(kind),
    isLookup: true,
    lookupOptions: { foreignTableId, linkFieldId, lookupFieldId },
  });

const createConditionalLookup = async (
  tableId: string,
  name: string,
  kind: "text" | "number" | "select" | "link",
  foreignTableId: string,
  lookupFieldId: string,
  filterSourceFieldId: string,
  hostKeyFieldId: string,
) =>
  createField(tableId, {
    name,
    type: lookupFieldType(kind),
    isLookup: true,
    isConditionalLookup: true,
    lookupOptions: {
      foreignTableId,
      lookupFieldId,
      filter: {
        conjunction: "and",
        filterSet: [
          {
            fieldId: filterSourceFieldId,
            operator: "is",
            value: { type: "field", fieldId: hostKeyFieldId },
          },
        ],
      },
      limit: 1,
    },
  });

const createFormulaFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  tableId: string,
  formulas: Array<{ name: string; expression: string }>,
  fieldIdByName: TableFieldIds,
) => {
  for (const formula of formulas) {
    const created = await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createFormula:${formula.name}`,
      () =>
        createField(tableId, {
          name: formula.name,
          type: FieldType.Formula,
          options: {
            expression: compileFormulaExpression(
              formula.expression,
              fieldIdByName,
            ),
          },
        }),
    );
    fieldIdByName[formula.name] = created.id;
  }
};

const restoreFixture = async (
  baseId: string,
  config: CircularLinkPropagationCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<Fixture | undefined> => {
  if (!seedCacheInfo.enabled) {
    return;
  }
  const subOrdersTableName = seedCacheInfo.seedTableName;
  const cachedSubOrders = await findSeedTable(baseId, subOrdersTableName);
  if (!cachedSubOrders) {
    return;
  }
  try {
    const tableMeta = await getTable(baseId, cachedSubOrders.id);
    const cachedSeed = parseCachedSeed(tableMeta.description);
    if (
      !cachedSeed ||
      cachedSeed.fixtureVersion !== FIXTURE_VERSION ||
      cachedSeed.orderRowCount !== config.orderRowCount ||
      cachedSeed.subOrderRowCount !== config.subOrderRowCount ||
      cachedSeed.purificationRowCount !== config.purificationRowCount ||
      cachedSeed.plasmidRowCount !== config.plasmidRowCount ||
      cachedSeed.subOrderRecordIds.length !== config.subOrderRowCount ||
      cachedSeed.purificationRecordIds.length !== config.purificationRowCount
    ) {
      throw new Error(
        `Missing or stale cached seed metadata for ${subOrdersTableName}`,
      );
    }
    const subOrderFieldVos = (await getFields(
      cachedSubOrders.id,
    )) as NamedField[];
    const purificationFieldVos = (await getFields(
      cachedSeed.purificationTableId,
    )) as NamedField[];
    const subOrderFields = fieldIdMap(subOrderFieldVos);
    const purificationFields = fieldIdMap(purificationFieldVos);
    const backrefFieldId = resolveNamedField(
      subOrderFieldVos,
      SUBORDER_PURIFICATION_LINK_FIELD,
    ).options?.symmetricFieldId;
    const backrefDupFieldId = resolveNamedField(
      subOrderFieldVos,
      SUBORDER_PURIFICATION_LINK_DUP_FIELD,
    ).options?.symmetricFieldId;
    if (!backrefFieldId || !backrefDupFieldId) {
      throw new Error("Cached seed is missing symmetric purification links");
    }
    const fixture: Fixture = {
      subOrdersTableId: cachedSubOrders.id,
      subOrdersTableName: cachedSubOrders.name,
      ordersTableId: cachedSeed.ordersTableId,
      purificationTableId: cachedSeed.purificationTableId,
      plasmidTableId: cachedSeed.plasmidTableId,
      subOrderFields,
      purificationFields,
      purificationBackrefFieldId: backrefFieldId,
      purificationBackrefDupFieldId: backrefDupFieldId,
      subOrderRecords: cachedSeed.subOrderRecordIds.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      purificationRecords: cachedSeed.purificationRecordIds.map(
        (recordId, index) => ({ rowNumber: index + 1, recordId }),
      ),
      seedBatchDurations: [0],
      seedCacheInfo,
      seedCacheHit: true,
      reusableSeed: true,
    };
    await waitForSamples(fixture, config, "seed");
    return fixture;
  } catch (error) {
    console.warn(
      `Invalid cached circular-link seed ${subOrdersTableName}; rebuilding`,
      error,
    );
    const cachedSeed = parseCachedSeed(
      (await getTable(baseId, cachedSubOrders.id).catch(() => null))
        ?.description,
    );
    for (const tableId of [
      cachedSubOrders.id,
      cachedSeed?.ordersTableId,
      cachedSeed?.purificationTableId,
      cachedSeed?.plasmidTableId,
    ]) {
      if (tableId) {
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (cleanupError) {
          console.warn(
            `Failed to delete stale seed table ${tableId}`,
            cleanupError,
          );
        }
      }
    }
    return;
  }
};

const createFixture = async (
  baseId: string,
  config: CircularLinkPropagationCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
  seedCacheInfo: SeedCacheInfo,
  fallbackTableName: string,
): Promise<Fixture> => {
  const subOrdersTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : fallbackTableName;
  const ordersTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "orders")
    : `${fallbackTableName}-orders`;
  const purificationTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "purification")
    : `${fallbackTableName}-purification`;
  const plasmidTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "plasmid")
    : `${fallbackTableName}-plasmid`;

  const createdTableIds: string[] = [];
  const seedBatchDurations: number[] = [];
  try {
    // --- Plasmid (conditional lookup source; 3 rows) ---
    const plasmid = await createTable(baseId, {
      name: plasmidTableName,
      fields: plasmidPlainFields(),
      records: [],
    });
    createdTableIds.push(plasmid.id);
    const plasmidRecordIds = await seedRecordsInBatches(
      plasmid.id,
      range(config.plasmidRowCount).map((n) => ({
        [TITLE_FIELD]: plasmidTitle(n),
        [PLASMID_TYPE_KEY_FIELD]: plasmidTypeKey(n),
        [PLASMID_TOTAL_FIELD]: plasmidTotalAmount(n),
        [PLASMID_BACKBONE_FIELD]: plasmidBackbone(n),
        [PLASMID_GRADE_FIELD]: plasmidGrade(n),
        ...Object.fromEntries(
          range(PLASMID_NOTE_COUNT).map((i) => [
            numberedField("pl_note", i),
            plasmidNote(i, n),
          ]),
        ),
        ...Object.fromEntries(
          range(PLASMID_METRIC_COUNT).map((i) => [
            numberedField("pl_metric", i),
            plasmidMetric(i, n),
          ]),
        ),
      })),
      config.batchSize,
      FieldKeyType.Name,
      seedBatchDurations,
    );

    // --- Orders (6 own-field formulas, then records) ---
    const orders = await createTable(baseId, {
      name: ordersTableName,
      fields: orderPlainFields(),
      records: [],
    });
    createdTableIds.push(orders.id);
    const orderFieldIds = fieldIdMap(
      (await getFields(orders.id)) as NamedField[],
    );
    await createFormulaFields(
      perfCase,
      context,
      orders.id,
      ORDER_FORMULAS,
      orderFieldIds,
    );
    const orderRecordIds = await seedRecordsInBatches(
      orders.id,
      range(config.orderRowCount).map((n) => ({
        [TITLE_FIELD]: orderTitle(n),
        ...Object.fromEntries(
          range(ORDER_ATTR_COUNT).map((i) => [
            numberedField("o_attr", i),
            orderAttr(i, n),
          ]),
        ),
        ...Object.fromEntries(
          range(ORDER_TEXT_COUNT).map((i) => [
            numberedField("o_text", i),
            orderText(i, n),
          ]),
        ),
        ...Object.fromEntries(
          range(ORDER_NUM_COUNT).map((i) => [
            numberedField("o_num", i),
            orderNum(i, n),
          ]),
        ),
      })),
      config.batchSize,
      FieldKeyType.Name,
      seedBatchDurations,
    );

    // --- SubOrders + Purification plain shells ---
    const subOrders = await createTable(baseId, {
      name: subOrdersTableName,
      fields: subOrderPlainFields(),
      records: [],
    });
    createdTableIds.push(subOrders.id);
    const purification = await createTable(baseId, {
      name: purificationTableName,
      fields: purificationPlainFields(),
      records: [],
    });
    createdTableIds.push(purification.id);

    // --- Links (incl. the duplicate one-many purification pair) ---
    await createLinkField(
      subOrders.id,
      SUBORDER_ORDER_LINK_FIELD,
      orders.id,
      Relationship.ManyOne,
      true,
    );
    await createLinkField(
      subOrders.id,
      SUBORDER_PLASMID_LINK_FIELD,
      plasmid.id,
      Relationship.ManyOne,
      true,
    );
    await createLinkField(
      subOrders.id,
      SUBORDER_PURIFICATION_LINK_FIELD,
      purification.id,
      Relationship.OneMany,
      false,
    );
    await createLinkField(
      subOrders.id,
      SUBORDER_PURIFICATION_LINK_DUP_FIELD,
      purification.id,
      Relationship.OneMany,
      false,
    );
    await createLinkField(
      purification.id,
      PURIFICATION_PLASMID_LINK_FIELD,
      plasmid.id,
      Relationship.ManyOne,
      true,
    );
    await createLinkField(
      purification.id,
      PURIFICATION_ORDER_LINK_FIELD,
      orders.id,
      Relationship.ManyOne,
      true,
    );

    let subOrderFieldVos = (await getFields(subOrders.id)) as NamedField[];
    const subOrderFields = fieldIdMap(subOrderFieldVos);
    const backrefFieldId = resolveNamedField(
      subOrderFieldVos,
      SUBORDER_PURIFICATION_LINK_FIELD,
    ).options?.symmetricFieldId;
    const backrefDupFieldId = resolveNamedField(
      subOrderFieldVos,
      SUBORDER_PURIFICATION_LINK_DUP_FIELD,
    ).options?.symmetricFieldId;
    if (!backrefFieldId || !backrefDupFieldId) {
      throw new Error(
        "One-many purification links did not create symmetric fields",
      );
    }
    const plasmidFieldIds = fieldIdMap(
      (await getFields(plasmid.id)) as NamedField[],
    );
    let purificationFieldVos = (await getFields(
      purification.id,
    )) as NamedField[];
    const purificationFields = fieldIdMap(purificationFieldVos);

    // --- SubOrders computed wave 1: order lookups + conditional lookups ---
    for (const spec of SUBORDER_ORDER_LOOKUPS) {
      const created = await withPerfTraceStep(
        context,
        perfCase,
        `seedBuild:createLookup:${spec.name}`,
        () =>
          createLookup(
            subOrders.id,
            spec.name,
            spec.kind,
            orders.id,
            subOrderFields[SUBORDER_ORDER_LINK_FIELD]!,
            orderFieldIds[spec.target]!,
          ),
      );
      subOrderFields[spec.name] = created.id;
    }
    for (const spec of SUBORDER_PLASMID_CONDITIONAL_LOOKUPS) {
      const created = await withPerfTraceStep(
        context,
        perfCase,
        `seedBuild:createConditionalLookup:${spec.name}`,
        () =>
          createConditionalLookup(
            subOrders.id,
            spec.name,
            spec.kind,
            plasmid.id,
            plasmidFieldIds[spec.target]!,
            plasmidFieldIds[PLASMID_TYPE_KEY_FIELD]!,
            subOrderFields[SUBORDER_PLASMID_TYPE_KEY_FIELD]!,
          ),
      );
      subOrderFields[spec.name] = created.id;
    }

    // --- Purification computed wave 1: plasmid/order lookups + reverse
    // lookups of SubOrders plain fields (the formula-target reverse lookup
    // waits for wave 2) ---
    for (const spec of PURIFICATION_PLASMID_LOOKUPS) {
      const created = await withPerfTraceStep(
        context,
        perfCase,
        `seedBuild:createLookup:${spec.name}`,
        () =>
          createLookup(
            purification.id,
            spec.name,
            spec.kind,
            plasmid.id,
            purificationFields[PURIFICATION_PLASMID_LINK_FIELD]!,
            plasmidFieldIds[spec.target]!,
          ),
      );
      purificationFields[spec.name] = created.id;
    }
    for (const spec of PURIFICATION_ORDER_LOOKUPS) {
      const created = await withPerfTraceStep(
        context,
        perfCase,
        `seedBuild:createLookup:${spec.name}`,
        () =>
          createLookup(
            purification.id,
            spec.name,
            spec.kind,
            orders.id,
            purificationFields[PURIFICATION_ORDER_LINK_FIELD]!,
            orderFieldIds[spec.target]!,
          ),
      );
      purificationFields[spec.name] = created.id;
    }
    const reverseLinkIdFor = (via: "backref" | "backref-dup") =>
      via === "backref" ? backrefFieldId : backrefDupFieldId;
    for (const spec of PURIFICATION_SUBORDER_LOOKUPS.filter(
      (candidate) => candidate.target !== "so_expression_card",
    )) {
      const created = await withPerfTraceStep(
        context,
        perfCase,
        `seedBuild:createLookup:${spec.name}`,
        () =>
          createLookup(
            purification.id,
            spec.name,
            spec.kind,
            subOrders.id,
            reverseLinkIdFor(spec.via),
            subOrderFields[spec.target]!,
          ),
      );
      purificationFields[spec.name] = created.id;
    }
    await createFormulaFields(
      perfCase,
      context,
      purification.id,
      PURIFICATION_FORMULAS.filter((formula) => formula.wave === 1),
      purificationFields,
    );

    // --- SubOrders computed wave 2: purification lookups (incl. the
    // formula-over-lookup pull of actual_expression) + formulas ---
    for (const spec of SUBORDER_PURIFICATION_LOOKUPS) {
      const created = await withPerfTraceStep(
        context,
        perfCase,
        `seedBuild:createLookup:${spec.name}`,
        () =>
          createLookup(
            subOrders.id,
            spec.name,
            spec.kind,
            purification.id,
            subOrderFields[SUBORDER_PURIFICATION_LINK_FIELD]!,
            purificationFields[spec.target]!,
          ),
      );
      subOrderFields[spec.name] = created.id;
    }
    await createFormulaFields(
      perfCase,
      context,
      subOrders.id,
      SUBORDER_FORMULAS,
      subOrderFields,
    );

    // --- Purification computed wave 2: close the circle ---
    for (const spec of PURIFICATION_SUBORDER_LOOKUPS.filter(
      (candidate) => candidate.target === "so_expression_card",
    )) {
      const created = await withPerfTraceStep(
        context,
        perfCase,
        `seedBuild:createLookup:${spec.name}`,
        () =>
          createLookup(
            purification.id,
            spec.name,
            spec.kind,
            subOrders.id,
            reverseLinkIdFor(spec.via),
            subOrderFields[spec.target]!,
          ),
      );
      purificationFields[spec.name] = created.id;
    }
    await createFormulaFields(
      perfCase,
      context,
      purification.id,
      PURIFICATION_FORMULAS.filter((formula) => formula.wave === 2),
      purificationFields,
    );

    // --- Seed SubOrders records (order + plasmid links set at insert) ---
    const subOrderRecordIds = await seedRecordsInBatches(
      subOrders.id,
      range(config.subOrderRowCount).map((s) => ({
        [TITLE_FIELD]: subOrderTitle(s),
        [SUBORDER_PLASMID_TYPE_KEY_FIELD]: subOrderPlasmidTypeKey(s, config),
        ...Object.fromEntries(
          range(SUBORDER_TEXT_COUNT).map((i) => [
            numberedField("so_text", i),
            subOrderText(i, s),
          ]),
        ),
        ...Object.fromEntries(
          range(SUBORDER_NUM_COUNT).map((i) => [
            numberedField("so_num", i),
            subOrderNum(i, s),
          ]),
        ),
        ...Object.fromEntries(
          range(SUBORDER_SELECT_COUNT).map((i) => [
            numberedField("so_select", i),
            subOrderSelect(i, s),
          ]),
        ),
        ...Object.fromEntries(
          range(SUBORDER_DATE_COUNT).map((i) => [
            numberedField("so_date", i),
            subOrderDate(),
          ]),
        ),
        [SUBORDER_ORDER_LINK_FIELD]: {
          id: orderRecordIds[orderRowForSubOrder(s, config) - 1]!,
        },
        [SUBORDER_PLASMID_LINK_FIELD]: {
          id: plasmidRecordIds[plasmidRowForSubOrder(s, config) - 1]!,
        },
      })),
      config.batchSize,
      FieldKeyType.Name,
      seedBatchDurations,
    );

    // --- Seed Purification records. Field keys are ids because the two
    // symmetric backref cells have server-generated names. Each insert wires
    // BOTH backrefs to the same SubOrder (the duplicate-link fingerprint). ---
    const purificationRecordIds = await seedRecordsInBatches(
      purification.id,
      range(config.purificationRowCount).map((p) => {
        const s = subOrderRowForPurification(p, config);
        return {
          [purificationFields[TITLE_FIELD]!]: purificationTitle(p),
          [purificationFields[PURIFICATION_EXPRESSION_FIELD]!]:
            seedExpressionValue(p),
          [purificationFields[PURIFICATION_BATCH_FIELD]!]:
            purificationBatchCode(p),
          [purificationFields[PURIFICATION_OPERATOR_FIELD]!]:
            purificationOperator(p),
          [purificationFields[PURIFICATION_METHOD_FIELD]!]:
            purificationMethod(p),
          [purificationFields[PURIFICATION_PURITY_FIELD]!]:
            purificationPurity(p),
          [purificationFields[PURIFICATION_YIELD_FIELD]!]: purificationYield(p),
          ...Object.fromEntries(
            range(PURIFICATION_TEXT_COUNT).map((i) => [
              purificationFields[numberedField("p_text", i)]!,
              purificationText(i, p),
            ]),
          ),
          ...Object.fromEntries(
            range(PURIFICATION_NUM_COUNT).map((i) => [
              purificationFields[numberedField("p_num", i)]!,
              purificationNum(i, p),
            ]),
          ),
          ...Object.fromEntries(
            range(PURIFICATION_SELECT_COUNT).map((i) => [
              purificationFields[numberedField("p_select", i)]!,
              purificationSelect(i, p),
            ]),
          ),
          [backrefFieldId]: { id: subOrderRecordIds[s - 1]! },
          [backrefDupFieldId]: { id: subOrderRecordIds[s - 1]! },
          [purificationFields[PURIFICATION_PLASMID_LINK_FIELD]!]: {
            id: plasmidRecordIds[plasmidRowForPurification(p, config) - 1]!,
          },
          [purificationFields[PURIFICATION_ORDER_LINK_FIELD]!]: {
            id: orderRecordIds[orderRowForPurification(p, config) - 1]!,
          },
        };
      }),
      config.purificationBatchSize,
      FieldKeyType.Id,
      seedBatchDurations,
    );

    await persistCachedSeed(baseId, subOrders.id, {
      fixtureVersion: FIXTURE_VERSION,
      orderRowCount: config.orderRowCount,
      subOrderRowCount: config.subOrderRowCount,
      purificationRowCount: config.purificationRowCount,
      plasmidRowCount: config.plasmidRowCount,
      ordersTableId: orders.id,
      purificationTableId: purification.id,
      plasmidTableId: plasmid.id,
      subOrderRecordIds,
      purificationRecordIds,
    });

    // Refresh field maps so later phases see every created field.
    subOrderFieldVos = (await getFields(subOrders.id)) as NamedField[];
    purificationFieldVos = (await getFields(purification.id)) as NamedField[];

    return {
      subOrdersTableId: subOrders.id,
      subOrdersTableName,
      ordersTableId: orders.id,
      purificationTableId: purification.id,
      plasmidTableId: plasmid.id,
      subOrderFields: fieldIdMap(subOrderFieldVos),
      purificationFields: fieldIdMap(purificationFieldVos),
      purificationBackrefFieldId: backrefFieldId,
      purificationBackrefDupFieldId: backrefDupFieldId,
      subOrderRecords: subOrderRecordIds.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      purificationRecords: purificationRecordIds.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      seedBatchDurations,
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
    };
  } catch (error) {
    for (const tableId of createdTableIds.reverse()) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to cleanup incomplete seed ${tableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const prepareFixture = async (
  baseId: string,
  fallbackTableName: string,
  config: CircularLinkPropagationCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<Fixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "circular-link-propagation",
    fixtureVersion: FIXTURE_VERSION,
    seedConfig: getComputedSeedConfig(config) as never,
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
      new URL("./circular-link-propagation-workload.ts", import.meta.url),
    ],
  });
  return (
    (await restoreFixture(baseId, config, seedCacheInfo)) ??
    createFixture(
      baseId,
      config,
      perfCase,
      context,
      seedCacheInfo,
      fallbackTableName,
    )
  );
};

// ---------------------------------------------------------------------------
// Measured operation
// ---------------------------------------------------------------------------

const writeExpressionValues = async (
  fixture: Fixture,
  config: CircularLinkPropagationCaseConfig,
  phase: CircularLinkPhase,
) => {
  const window = resolveMutationWindow(
    config.purificationRowCount,
    config.mutation,
  );
  const targets = fixture.purificationRecords.slice(
    window.startOffset,
    window.endOffsetExclusive,
  );
  const expressionFieldId =
    fixture.purificationFields[PURIFICATION_EXPRESSION_FIELD]!;
  const updates = targets.map((record) => ({
    id: record.recordId,
    fields: {
      [expressionFieldId]:
        phase === "updated"
          ? updatedExpressionValue(record.rowNumber)
          : seedExpressionValue(record.rowNumber),
    },
  }));
  let requested = 0;
  let updated = 0;
  let responseHeaders: Record<string, string> = {};
  for (const batch of chunk(updates, config.writeBatchSize)) {
    const response = await updateRecords(fixture.purificationTableId, {
      fieldKeyType: FieldKeyType.Id,
      typecast: false,
      records: batch,
    });
    const data = response.data as unknown;
    const batchUpdated = Array.isArray(data)
      ? data.length
      : ((data as { records?: unknown[] })?.records?.length ?? 0);
    expect(response.status).toBe(200);
    expect(batchUpdated).toBe(batch.length);
    requested += batch.length;
    updated += batchUpdated;
    responseHeaders = pickRoutingResponseHeaders(
      response.headers as Record<string, unknown>,
    );
  }
  return {
    requestedRecords: requested,
    updatedRecords: updated,
    responseHeaders,
  };
};

const runMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: CircularLinkPropagationCaseConfig,
  fixture: Fixture,
): Promise<Measurement<PrimaryResult>> => {
  const purificationBySubOrder = purificationRowBySubOrderRow(config);
  const affectedRows = affectedSubOrderRows(config);

  let sourceUpdateMs = 0;
  let hostReadinessMs = 0;
  let requestedRecords = 0;
  let updatedRecords = 0;
  let responseHeaders: Record<string, string> = {};

  const totalMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, async () => {
        const writeMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          "sourceUpdate",
          () =>
            measureAsync("sourceUpdate", () =>
              writeExpressionValues(fixture, config, "updated"),
            ),
        );
        sourceUpdateMs = writeMeasurement.durationMs;
        requestedRecords = writeMeasurement.result.requestedRecords;
        updatedRecords = writeMeasurement.result.updatedRecords;
        responseHeaders = writeMeasurement.result.responseHeaders;

        const readinessMeasurement = await measureAsync("hostReadiness", () =>
          pollUntilReady(
            {
              timeoutMs: config.verify.timeoutMs ?? 300_000,
              pollIntervalMs: config.verify.pollIntervalMs ?? 250,
              description: "affected sub-order lookup+formula readiness",
            },
            () =>
              assertAffectedSubOrders(
                fixture,
                config,
                context,
                purificationBySubOrder,
              ),
          ),
        );
        hostReadinessMs = readinessMeasurement.durationMs;
      }),
  );

  // Full circular cascade (both tables, including Purification's reverse
  // lookups over the changed SubOrders formula) proven OUTSIDE the primary
  // timer, mirroring the conditional-query propagation pattern.
  const cascadeMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    "cascadeVerification",
    () =>
      measureAsync("cascadeVerification", () =>
        waitForFullCascade(fixture, config, "updated", context),
      ),
  );

  const routing = assertEngineRouting(context, responseHeaders, {
    operation: "updateRecords",
  });

  return {
    ...totalMeasurement,
    result: {
      sourceUpdateMs,
      hostReadinessMs,
      cascadeVerificationMs: cascadeMeasurement.durationMs,
      affectedSubOrderCount: affectedRows.length,
      requestedRecords,
      updatedRecords,
      responseHeaders,
      routing,
      subOrdersScan: cascadeMeasurement.result.subOrdersScan,
      purificationScan: cascadeMeasurement.result.purificationScan,
    },
  };
};

// ---------------------------------------------------------------------------
// Cleanup (class C: reverse the scalar mutation, verify, else drop all four)
// ---------------------------------------------------------------------------

const cleanupFixture = async ({
  baseId,
  fixture,
  config,
}: {
  baseId: string;
  fixture: Fixture | undefined;
  config: CircularLinkPropagationCaseConfig;
}) => {
  if (!fixture || isExecuteDbIsolated()) {
    // CI execute jobs run on a disposable restored DB copy; skip all cleanup.
    return;
  }
  const dropAllTables = async () => {
    for (const tableId of [
      fixture.subOrdersTableId,
      fixture.purificationTableId,
      fixture.ordersTableId,
      fixture.plasmidTableId,
    ]) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (error) {
        console.warn(`Failed to cleanup table ${tableId}`, error);
      }
    }
  };
  if (!fixture.reusableSeed) {
    await dropAllTables();
    return;
  }
  let restored = false;
  try {
    await writeExpressionValues(fixture, config, "seed");
    await waitForSamples(fixture, config, "seed");
    restored = true;
  } catch (error) {
    console.warn(
      `Failed to restore cached circular-link seed ${fixture.subOrdersTableId}; deleting it`,
      error,
    );
  }
  if (!restored) {
    await dropAllTables();
  }
};

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

const buildResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: CircularLinkPropagationCaseConfig;
  fixture?: Fixture;
  prepareMeasurement?: Measurement<Fixture>;
  seedReadyMeasurement?: Measurement<{ checkedRecords: number }>;
  primaryMeasurement?: Measurement<PrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const primary = primaryMeasurement?.result;
  return {
    metrics: {
      ...(prepareMeasurement
        ? { prepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(fixture
        ? {
            maxSeedBatchMs: fixture.seedBatchDurations.length
              ? roundMetric(Math.max(...fixture.seedBatchDurations))
              : 0,
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            ...(fixture.seedCacheHit
              ? { seedRestoreMs: prepareMeasurement?.durationMs ?? 0 }
              : fixture.seedCacheInfo.enabled
                ? { seedBuildMs: prepareMeasurement?.durationMs ?? 0 }
                : {}),
          }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(primaryMeasurement && primary
        ? {
            circularPropagationReadyMs: primaryMeasurement.durationMs,
            sourceUpdateMs: primary.sourceUpdateMs,
            hostReadinessMs: primary.hostReadinessMs,
            cascadeVerificationMs: primary.cascadeVerificationMs,
          }
        : {}),
    },
    thresholds:
      primaryMeasurement && primary
        ? [
            {
              metric: config.threshold.metric,
              max: getPrimaryThresholdMs(config.threshold.maxMs),
              unit: "ms",
            },
          ]
        : [],
    phases: [
      ...(prepareMeasurement
        ? [
            {
              name: prepareMeasurement.name,
              durationMs: prepareMeasurement.durationMs,
            },
          ]
        : []),
      ...(seedReadyMeasurement
        ? [
            {
              name: seedReadyMeasurement.name,
              durationMs: seedReadyMeasurement.durationMs,
            },
          ]
        : []),
      ...(primaryMeasurement
        ? [
            {
              name: primaryMeasurement.name,
              durationMs: primaryMeasurement.durationMs,
            },
          ]
        : []),
      ...(primary?.cascadeVerificationMs
        ? [
            {
              name: "cascadeVerification",
              durationMs: primary.cascadeVerificationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: "edit-purification-cells-await-circular-cascade",
      subOrdersTableId: fixture?.subOrdersTableId,
      subOrdersTableName: fixture?.subOrdersTableName,
      ordersTableId: fixture?.ordersTableId,
      purificationTableId: fixture?.purificationTableId,
      plasmidTableId: fixture?.plasmidTableId,
      rowCounts: {
        orders: config.orderRowCount,
        subOrders: config.subOrderRowCount,
        purification: config.purificationRowCount,
        plasmid: config.plasmidRowCount,
      },
      fieldCounts: FIELD_COUNTS,
      computedFieldCounts: COMPUTED_FIELD_COUNTS,
      mutation: resolveMutationWindow(
        config.purificationRowCount,
        config.mutation,
      ),
      readiness: primary
        ? {
            readPath: "get-record",
            affectedSubOrderCount: primary.affectedSubOrderCount,
            fullCascadeAfterPrimary: true,
            cascadeVerificationMs: primary.cascadeVerificationMs,
          }
        : undefined,
      request: fixture
        ? {
            method: "PATCH",
            path: `/api/table/${fixture.purificationTableId}/record`,
            fieldKeyType: "id",
            typecast: false,
            recordCount: resolveMutationWindow(
              config.purificationRowCount,
              config.mutation,
            ).recordCount,
            writeBatchSize: config.writeBatchSize,
            expressionFieldId:
              fixture.purificationFields[PURIFICATION_EXPRESSION_FIELD],
          }
        : undefined,
      update: primary
        ? {
            requestedRecords: primary.requestedRecords,
            updatedRecords: primary.updatedRecords,
            responseHeaders: primary.responseHeaders,
          }
        : undefined,
      routing: primary?.routing,
      subOrdersScan: primary?.subOrdersScan,
      purificationScan: primary?.purificationScan,
      seed: fixture
        ? {
            seededSubOrders: fixture.subOrderRecords.length,
            seededPurifications: fixture.purificationRecords.length,
            batchCount: fixture.seedBatchDurations.length,
            ready: seedReadyMeasurement?.result,
            cache: {
              enabled: fixture.seedCacheInfo.enabled,
              cacheHit: fixture.seedCacheHit,
              reusable: fixture.reusableSeed,
              seedHash: fixture.seedCacheInfo.seedHash,
              seedHashShort: fixture.seedCacheInfo.seedHashShort,
              seedTableName: fixture.seedCacheInfo.seedTableName,
              schemaSignature: fixture.seedCacheInfo.schemaSignature,
            },
          }
        : undefined,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    },
  };
};

// ---------------------------------------------------------------------------
// Lifecycle wiring (record-mutation-lifecycle, like link-computed-propagation)
// ---------------------------------------------------------------------------

type ClpLifecycleConfig = CircularLinkPropagationCaseConfig & {
  tableNamePrefix: string;
};

const circularLinkLifecycleSpec: RecordMutationLifecycleSpec<
  ClpLifecycleConfig,
  Fixture,
  { checkedRecords: number },
  PrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase, context }) =>
    prepareFixture(baseId, tableName, config, perfCase, context),
  assertSeedReady: ({ fixture, config }) =>
    waitForSamples(fixture, config, "seed"),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runMeasuredOperation(perfCase, context, config, fixture),
  buildResult: ({
    config,
    fixture,
    prepareMeasurement,
    seedReadyMeasurement,
    primaryMeasurement,
    error,
  }) =>
    buildResult({
      config,
      fixture,
      prepareMeasurement,
      seedReadyMeasurement,
      primaryMeasurement,
      error,
    }),
  cleanup: cleanupFixture,
};

// Smoke overrides are applied once at the boundary so every spec callback (and
// the seed-cache hash) sees the overridden config.
const toLifecyclePerfCase = (perfCase: PerfCase): PerfCase => {
  const config = applySmokeOverrides(
    perfCase.config as CircularLinkPropagationCaseConfig,
  );
  return { ...perfCase, config } as PerfCase;
};

export const runCircularLinkPropagationCase = async (
  perfCase: PerfCaseFor<"circular-link-propagation">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(
    toLifecyclePerfCase(perfCase),
    context,
    circularLinkLifecycleSpec,
  );

export const seedCircularLinkPropagationCase = async (
  perfCase: PerfCaseFor<"circular-link-propagation">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(
    toLifecyclePerfCase(perfCase),
    context,
    circularLinkLifecycleSpec,
  );
