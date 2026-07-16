import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import {
  convertField as apiConvertField,
  updateRecords,
  updateTableDescription,
} from "@teable/openapi";
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
import { getPrimaryThresholdMs, isExecuteDbIsolated } from "../env";
import { measureAsync, roundMetric, type Measurement } from "../metrics";
import { pollUntilReady } from "../readiness";
import { forEachRecordPage } from "../record-page-scan";
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
import { withPerfTraceStep } from "../trace-collector";
import type {
  ComputedChainMutationCaseConfig,
  PerfCase,
  PerfCaseFor,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  buildExpectedOrderState,
  buildExpectedUserState,
  purchaseRowForOrder,
  resolveCascadeImpact,
  resolveFormulaDependencyPlan,
  userRowForOrder,
  type ComputedChainFormulaDependencyMutation,
  type ComputedChainFixtureShape,
  type ComputedChainMutation,
  type ComputedChainPhase,
} from "./computed-chain-mutation-model";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const FIXTURE_VERSION = "computed-chain-mutation-v1";
const METADATA_PREFIX = "perf-lab-computed-chain-mutation:";

const USER_TITLE = "Key";
const USER_FIRST_NAME = "first_name";
const USER_LAST_NAME = "last_name";
const USER_EMAIL = "email";
const USER_STATUS = "Status";

const ORDER_TITLE = "Title";
const USER_LINK = "customer_id_fk";
const PURCHASE_LINK = "purchase_fk";
const LOOKUP_FIRST_NAME = "lookup_first_name";
const LOOKUP_LAST_NAME = "lookup_last_name";
const LOOKUP_EMAIL = "lookup_email";
const LOOKUP_STATUS = "lookup_status";

const PROFILE_SEED = "profile_seed";
const PROFILE_L2 = "profile_l2";
const PROFILE_L3 = "profile_l3";
const PROFILE_L4 = "profile_l4";
const ORDER_CARD = "order_card";

const PURCHASE_TITLE = "Title";
const PURCHASE_CARDS = "p_cards";
const PURCHASE_LABEL = "p_label";

const FORMULA_NAMES = [
  PROFILE_SEED,
  PROFILE_L2,
  PROFILE_L3,
  PROFILE_L4,
  ORDER_CARD,
] as const;

type FormulaMutation = Extract<ComputedChainMutation, `formula-${string}`>;

const isFormulaMutation = (
  mutation: ComputedChainMutationCaseConfig["mutation"],
): mutation is FormulaMutation => mutation.startsWith("formula-");

const isFormulaDependencyMutation = (
  mutation: ComputedChainMutationCaseConfig["mutation"],
): mutation is ComputedChainFormulaDependencyMutation =>
  mutation === "formula-dependency-add" ||
  mutation === "formula-dependency-replace" ||
  mutation === "formula-dependency-remove";

type NamedField = {
  id: string;
  name: string;
  type?: string;
  options?: {
    expression?: string;
    symmetricFieldId?: string;
    choices?: Array<{ name: string }>;
  };
};

type UserFieldIds = {
  title: string;
  firstName: string;
  lastName: string;
  email: string;
  status: string;
};

type OrderFieldIds = {
  title: string;
  userLink: string;
  purchaseLink: string;
  lookupFirstName: string;
  lookupLastName: string;
  lookupEmail: string;
  lookupStatus: string;
  formulas: Record<(typeof FORMULA_NAMES)[number], string>;
};

type PurchaseFieldIds = {
  title: string;
  cards: string;
  label: string;
};

type SeededRecord = {
  rowNumber: number;
  recordId: string;
};

type Fixture = {
  usersTableId: string;
  ordersTableId: string;
  ordersTableName: string;
  purchaseTableId: string;
  userFields: UserFieldIds;
  orderFields: OrderFieldIds;
  purchaseFields: PurchaseFieldIds;
  userRecords: SeededRecord[];
  orderRecords: SeededRecord[];
  purchaseRecords: SeededRecord[];
  profileSeedDependencyIds: string[];
  seedBatchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type ScanResult = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  affectedRecords: number;
  unaffectedRecords: number;
};

type PrimaryResult = {
  mutationRequestMs: number;
  sourceWriteMs?: number;
  formulaUpdateMs?: number;
  postResponsePropagationMs: number;
  allAffectedOrdersReadyMs: number;
  purchaseCascadeReadyMs: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  updatedRecords?: number;
  convertedField?: { id: string; name: string; type: string };
  dependenciesBefore: string[];
  dependenciesAfter: string[];
  firstOrderRecordId?: string;
  ordersScan: ScanResult;
  purchaseScan: ScanResult;
  fullOrdersVerificationMs: number;
  purchaseVerificationMs: number;
};

type MutationRequestResult =
  | {
      kind: "foreign";
      updatedRecords: number;
      responseHeaders: Record<string, string>;
    }
  | {
      kind: "formula";
      convertedField: NonNullable<PrimaryResult["convertedField"]>;
      dependenciesAfter: string[];
      responseHeaders: Record<string, string>;
    };

type PropagationResult =
  | {
      kind: "full-cascade";
      ordersScan: ScanResult;
      purchaseScan: ScanResult;
    }
  | { kind: "first-order"; recordId: string };

type CachedSeed = {
  fixtureVersion: string;
  userCount: number;
  orderCount: number;
  purchaseCount: number;
  usersTableId: string;
  purchaseTableId: string;
  userRecordIds: string[];
  orderRecordIds: string[];
  purchaseRecordIds: string[];
};

const shapeFor = (
  config: ComputedChainMutationCaseConfig,
): ComputedChainFixtureShape => ({
  userCount: config.userCount,
  orderCount: config.orderCount,
  ordersPerUser: config.ordersPerUser,
  purchaseGroupSize: config.purchaseGroupSize,
  targetUserRow: config.targetUserRow,
});

const purchaseCount = (config: ComputedChainMutationCaseConfig) =>
  config.orderCount / config.purchaseGroupSize;

const orderTitle = (row: number) => `Order ${row}`;
const purchaseTitle = (row: number) => `Purchase ${row}`;
const userTitle = (row: number) => `User-${String(row).padStart(3, "0")}`;

const resolveNamedField = (fields: NamedField[], name: string) => {
  const field = fields.find((candidate) => candidate.name === name);
  if (!field) {
    throw new Error(
      `Missing field ${name}; available=${fields.map((item) => item.name).join(", ")}`,
    );
  }
  return field;
};

const resolveUserFields = (fields: NamedField[]): UserFieldIds => ({
  title: resolveNamedField(fields, USER_TITLE).id,
  firstName: resolveNamedField(fields, USER_FIRST_NAME).id,
  lastName: resolveNamedField(fields, USER_LAST_NAME).id,
  email: resolveNamedField(fields, USER_EMAIL).id,
  status: resolveNamedField(fields, USER_STATUS).id,
});

const resolveOrderFields = (fields: NamedField[]): OrderFieldIds => ({
  title: resolveNamedField(fields, ORDER_TITLE).id,
  userLink: resolveNamedField(fields, USER_LINK).id,
  purchaseLink: resolveNamedField(fields, PURCHASE_LINK).id,
  lookupFirstName: resolveNamedField(fields, LOOKUP_FIRST_NAME).id,
  lookupLastName: resolveNamedField(fields, LOOKUP_LAST_NAME).id,
  lookupEmail: resolveNamedField(fields, LOOKUP_EMAIL).id,
  lookupStatus: resolveNamedField(fields, LOOKUP_STATUS).id,
  formulas: Object.fromEntries(
    FORMULA_NAMES.map((name) => [name, resolveNamedField(fields, name).id]),
  ) as OrderFieldIds["formulas"],
});

const resolvePurchaseFields = (fields: NamedField[]): PurchaseFieldIds => ({
  title: resolveNamedField(fields, PURCHASE_TITLE).id,
  cards: resolveNamedField(fields, PURCHASE_CARDS).id,
  label: resolveNamedField(fields, PURCHASE_LABEL).id,
});

const normalizeComputedValue = (value: unknown): string => {
  if (value == null) {
    return "";
  }
  if (Array.isArray(value)) {
    return value.map(normalizeComputedValue).join(",");
  }
  if (typeof value === "object") {
    const object = value as { title?: unknown; name?: unknown };
    if (typeof object.title === "string") {
      return object.title;
    }
    if (typeof object.name === "string") {
      return object.name;
    }
  }
  return String(value);
};

const compileExpression = (
  expression: string,
  fieldIdByName: Map<string, string>,
) =>
  expression.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const id = fieldIdByName.get(name);
    return id ? `{${id}}` : match;
  });

const profileSeedExpression = (version: "V1" | "V2") =>
  `"${version}:" & {${LOOKUP_STATUS}} & ":" & {${LOOKUP_FIRST_NAME}} & " " & {${LOOKUP_LAST_NAME}}`;

const updatedProfileSeedExpression = (mutation: FormulaMutation) => {
  switch (mutation) {
    case "formula-expression":
      return profileSeedExpression("V2");
    case "formula-dependency-add":
      return `${profileSeedExpression("V2")} & "|" & {${LOOKUP_EMAIL}}`;
    case "formula-dependency-replace":
      return `"V2:" & {${LOOKUP_STATUS}} & ":" & {${LOOKUP_FIRST_NAME}} & " " & {${LOOKUP_EMAIL}}`;
    case "formula-dependency-remove":
      return `"V2:" & {${LOOKUP_STATUS}} & ":" & {${LOOKUP_FIRST_NAME}}`;
  }
};

const formulaDefinitions = (version: "V1" | "V2") => [
  {
    name: PROFILE_SEED,
    expression: profileSeedExpression(version),
  },
  {
    name: PROFILE_L2,
    expression: `{${PROFILE_SEED}} & "|" & {${LOOKUP_EMAIL}}`,
  },
  { name: PROFILE_L3, expression: `{${PROFILE_L2}} & "|L3"` },
  { name: PROFILE_L4, expression: `{${PROFILE_L3}} & "|L4"` },
  {
    name: ORDER_CARD,
    expression: `"ORDER " & {${ORDER_TITLE}} & "|" & {${PROFILE_L4}} & "|L5"`,
  },
];

const extractDependencyIds = (expression: string | undefined) =>
  [...(expression ?? "").matchAll(/\{([^}]+)\}/g)]
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value))
    .sort();

const parseRowNumber = (value: unknown, prefix: string) => {
  const text = normalizeComputedValue(value);
  if (!text.startsWith(prefix)) {
    throw new Error(`Expected ${prefix}<row>, got ${text}`);
  }
  const row = Number(text.slice(prefix.length));
  if (!Number.isInteger(row) || row <= 0) {
    throw new Error(`Expected integer row in ${text}`);
  }
  return row;
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

const getSeedConfig = (config: ComputedChainMutationCaseConfig) => ({
  baseId: config.baseId,
  userCount: config.userCount,
  orderCount: config.orderCount,
  ordersPerUser: config.ordersPerUser,
  purchaseGroupSize: config.purchaseGroupSize,
  targetUserRow: config.targetUserRow,
  batchSize: config.batchSize,
  userBatchSize: config.userBatchSize,
  fields: {
    users: [
      USER_TITLE,
      USER_FIRST_NAME,
      USER_LAST_NAME,
      USER_EMAIL,
      USER_STATUS,
    ],
    orders: [
      ORDER_TITLE,
      USER_LINK,
      PURCHASE_LINK,
      LOOKUP_FIRST_NAME,
      LOOKUP_LAST_NAME,
      LOOKUP_EMAIL,
      LOOKUP_STATUS,
      ...FORMULA_NAMES,
    ],
    purchase: [PURCHASE_TITLE, PURCHASE_CARDS, PURCHASE_LABEL],
  },
  formulas: formulaDefinitions("V1"),
  fixtureVersion: FIXTURE_VERSION,
});

const createRecordsInBatches = async (
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
  batchSize: number,
  fieldKeyType: FieldKeyType,
) => {
  const ids: string[] = [];
  const durations: number[] = [];
  for (const batch of chunk(records, batchSize)) {
    const measurement = await measureAsync("seedBatch", () =>
      createRecords(tableId, {
        fieldKeyType,
        typecast: true,
        records: batch,
      }),
    );
    if (measurement.result.records.length !== batch.length) {
      throw new Error(
        `Seed batch mismatch: expected ${batch.length}, got ${measurement.result.records.length}`,
      );
    }
    durations.push(measurement.durationMs);
    ids.push(...measurement.result.records.map((record) => record.id));
  }
  return { ids, durations };
};

const createOrderComputedFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  ordersTableId: string,
  usersTableId: string,
  userFields: UserFieldIds,
  userLinkFieldId: string,
) => {
  const lookups = [
    {
      name: LOOKUP_FIRST_NAME,
      type: FieldType.SingleLineText,
      lookupFieldId: userFields.firstName,
    },
    {
      name: LOOKUP_LAST_NAME,
      type: FieldType.SingleLineText,
      lookupFieldId: userFields.lastName,
    },
    {
      name: LOOKUP_EMAIL,
      type: FieldType.SingleLineText,
      lookupFieldId: userFields.email,
    },
    {
      name: LOOKUP_STATUS,
      type: FieldType.SingleSelect,
      lookupFieldId: userFields.status,
    },
  ];
  for (const lookup of lookups) {
    await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createLookup:${lookup.name}`,
      () =>
        createField(ordersTableId, {
          name: lookup.name,
          type: lookup.type,
          isLookup: true,
          lookupOptions: {
            foreignTableId: usersTableId,
            linkFieldId: userLinkFieldId,
            lookupFieldId: lookup.lookupFieldId,
          },
        }),
    );
  }

  const fields = (await getFields(ordersTableId)) as NamedField[];
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  for (const formula of formulaDefinitions("V1")) {
    const created = await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createFormula:${formula.name}`,
      () =>
        createField(ordersTableId, {
          name: formula.name,
          type: FieldType.Formula,
          options: {
            expression: compileExpression(formula.expression, fieldIdByName),
          },
        }),
    );
    fieldIdByName.set(formula.name, created.id);
  }
};

const createPurchaseComputedFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  purchaseTableId: string,
  ordersTableId: string,
  reverseOrdersLinkId: string,
  orderCardFieldId: string,
) => {
  await withPerfTraceStep(
    context,
    perfCase,
    `seedBuild:createRollup:${PURCHASE_CARDS}`,
    () =>
      createField(purchaseTableId, {
        name: PURCHASE_CARDS,
        type: FieldType.Rollup,
        options: { expression: "array_join({values})" },
        lookupOptions: {
          foreignTableId: ordersTableId,
          linkFieldId: reverseOrdersLinkId,
          lookupFieldId: orderCardFieldId,
        },
      }),
  );
  const fields = (await getFields(purchaseTableId)) as NamedField[];
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  await withPerfTraceStep(
    context,
    perfCase,
    `seedBuild:createFormula:${PURCHASE_LABEL}`,
    () =>
      createField(purchaseTableId, {
        name: PURCHASE_LABEL,
        type: FieldType.Formula,
        options: {
          expression: compileExpression(
            `"PURCHASE " & {${PURCHASE_TITLE}} & "::" & {${PURCHASE_CARDS}}`,
            fieldIdByName,
          ),
        },
      }),
  );
};

const deleteFixtureTables = async (baseId: string, fixture: Fixture) => {
  for (const tableId of [
    fixture.ordersTableId,
    fixture.usersTableId,
    fixture.purchaseTableId,
  ]) {
    try {
      await permanentDeleteTable(baseId, tableId);
    } catch (error) {
      console.warn(`Failed to delete computed-chain table ${tableId}`, error);
    }
  }
};

const assertOrderFields = (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  rowNumber: number,
  fields: Record<string, unknown>,
  phase: ComputedChainPhase,
) => {
  const expected = buildExpectedOrderState(shapeFor(config), rowNumber, {
    mutation: config.mutation,
    phase,
  });
  const checks: Array<[string, string, unknown]> = [
    [
      LOOKUP_FIRST_NAME,
      expected.lookupFirstName,
      fields[fixture.orderFields.lookupFirstName],
    ],
    [
      LOOKUP_LAST_NAME,
      expected.lookupLastName,
      fields[fixture.orderFields.lookupLastName],
    ],
    [
      LOOKUP_EMAIL,
      expected.lookupEmail,
      fields[fixture.orderFields.lookupEmail],
    ],
    [
      LOOKUP_STATUS,
      expected.lookupStatus,
      fields[fixture.orderFields.lookupStatus],
    ],
    [
      PROFILE_SEED,
      expected.profileSeed,
      fields[fixture.orderFields.formulas[PROFILE_SEED]],
    ],
    [
      PROFILE_L2,
      expected.profileL2,
      fields[fixture.orderFields.formulas[PROFILE_L2]],
    ],
    [
      PROFILE_L3,
      expected.profileL3,
      fields[fixture.orderFields.formulas[PROFILE_L3]],
    ],
    [
      PROFILE_L4,
      expected.profileL4,
      fields[fixture.orderFields.formulas[PROFILE_L4]],
    ],
    [
      ORDER_CARD,
      expected.orderCard,
      fields[fixture.orderFields.formulas[ORDER_CARD]],
    ],
  ];
  for (const [name, expectedValue, actualValue] of checks) {
    const actual = normalizeComputedValue(actualValue);
    if (actual !== expectedValue) {
      throw new Error(
        `Order ${rowNumber} ${name} mismatch: expected=${expectedValue}, actual=${actual}`,
      );
    }
  }
};

const orderProjection = (fixture: Fixture) => [
  fixture.orderFields.title,
  fixture.orderFields.lookupFirstName,
  fixture.orderFields.lookupLastName,
  fixture.orderFields.lookupEmail,
  fixture.orderFields.lookupStatus,
  ...FORMULA_NAMES.map((name) => fixture.orderFields.formulas[name]),
];

const purchaseChildOrderRows = (
  purchaseRow: number,
  config: ComputedChainMutationCaseConfig,
) => {
  const first = (purchaseRow - 1) * config.purchaseGroupSize + 1;
  return Array.from(
    { length: config.purchaseGroupSize },
    (_, index) => first + index,
  );
};

const assertPurchaseFields = (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  rowNumber: number,
  fields: Record<string, unknown>,
  phase: ComputedChainPhase,
) => {
  const cards = normalizeComputedValue(fields[fixture.purchaseFields.cards]);
  const label = normalizeComputedValue(fields[fixture.purchaseFields.label]);
  const prefix = `PURCHASE ${purchaseTitle(rowNumber)}::`;
  if (!label.startsWith(prefix)) {
    throw new Error(
      `Purchase ${rowNumber} label prefix mismatch: expected=${prefix}, actual=${label}`,
    );
  }
  for (const orderRow of purchaseChildOrderRows(rowNumber, config)) {
    const expectedCard = buildExpectedOrderState(shapeFor(config), orderRow, {
      mutation: config.mutation,
      phase,
    }).orderCard;
    if (!cards.includes(expectedCard)) {
      throw new Error(
        `Purchase ${rowNumber} rollup missing order ${orderRow}: ${expectedCard}`,
      );
    }
    if (!label.includes(expectedCard)) {
      throw new Error(
        `Purchase ${rowNumber} formula missing order ${orderRow}: ${expectedCard}`,
      );
    }
  }
};

const assertSeedSamples = async (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
) => {
  let checkedOrders = 0;
  const checkedPurchases = new Set<number>();
  for (const rowOffset of config.verify.sampleRows) {
    const seeded = fixture.orderRecords[rowOffset];
    if (!seeded) {
      throw new Error(`Missing seeded order at row offset ${rowOffset}`);
    }
    const record = await getRecord(fixture.ordersTableId, seeded.recordId);
    assertOrderFields(fixture, config, seeded.rowNumber, record.fields, "seed");
    checkedOrders += 1;

    const purchaseRow = purchaseRowForOrder(shapeFor(config), seeded.rowNumber);
    if (!checkedPurchases.has(purchaseRow)) {
      const purchaseRecord = fixture.purchaseRecords[purchaseRow - 1];
      if (!purchaseRecord) {
        throw new Error(`Missing seeded purchase ${purchaseRow}`);
      }
      const purchase = await getRecord(
        fixture.purchaseTableId,
        purchaseRecord.recordId,
      );
      assertPurchaseFields(
        fixture,
        config,
        purchaseRow,
        purchase.fields,
        "seed",
      );
      checkedPurchases.add(purchaseRow);
    }
  }
  return { checkedOrders, checkedPurchases: checkedPurchases.size };
};

const waitForSeedSamples = (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 180_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 100,
      description: "computed-chain seed samples",
    },
    () => assertSeedSamples(fixture, config),
  );

const assertOrdersFullScan = async (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  phase: ComputedChainPhase,
): Promise<ScanResult> => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const seen = new Set<number>();
  let affectedRecords = 0;
  let unaffectedRecords = 0;
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows: config.orderCount,
      pageSize,
      pageNoun: "orders",
      fetchPage: (skip, take) =>
        getRecords(fixture.ordersTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: orderProjection(fixture),
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseRowNumber(
        record.fields[fixture.orderFields.title],
        "Order ",
      );
      if (seen.has(rowNumber)) {
        throw new Error(`Duplicate order row ${rowNumber}`);
      }
      seen.add(rowNumber);
      assertOrderFields(fixture, config, rowNumber, record.fields, phase);
      const changed =
        isFormulaMutation(config.mutation) ||
        userRowForOrder(shapeFor(config), rowNumber) === config.targetUserRow;
      if (changed) {
        affectedRecords += 1;
      } else {
        unaffectedRecords += 1;
      }
    },
  );
  return {
    scannedRecords,
    pageSize,
    pageCount,
    affectedRecords,
    unaffectedRecords,
  };
};

const assertPurchasesFullScan = async (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  phase: ComputedChainPhase,
): Promise<ScanResult> => {
  const totalRows = purchaseCount(config);
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const impact = resolveCascadeImpact(shapeFor(config));
  const seen = new Set<number>();
  let affectedRecords = 0;
  let unaffectedRecords = 0;
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows,
      pageSize,
      pageNoun: "purchases",
      fetchPage: (skip, take) =>
        getRecords(fixture.purchaseTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [
            fixture.purchaseFields.title,
            fixture.purchaseFields.cards,
            fixture.purchaseFields.label,
          ],
          skip,
          take,
        }),
    },
    (record) => {
      const rowNumber = parseRowNumber(
        record.fields[fixture.purchaseFields.title],
        "Purchase ",
      );
      if (seen.has(rowNumber)) {
        throw new Error(`Duplicate purchase row ${rowNumber}`);
      }
      seen.add(rowNumber);
      assertPurchaseFields(fixture, config, rowNumber, record.fields, phase);
      const changed =
        isFormulaMutation(config.mutation) ||
        (rowNumber >= impact.firstAffectedPurchaseRow &&
          rowNumber <= impact.lastAffectedPurchaseRow);
      if (changed) {
        affectedRecords += 1;
      } else {
        unaffectedRecords += 1;
      }
    },
  );
  return {
    scannedRecords,
    pageSize,
    pageCount,
    affectedRecords,
    unaffectedRecords,
  };
};

const waitForOrdersFullScan = (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  phase: ComputedChainPhase,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 180_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 100,
      description: "computed-chain orders full scan",
    },
    () => assertOrdersFullScan(fixture, config, phase),
  );

const waitForPurchasesFullScan = (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  phase: ComputedChainPhase,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 180_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 100,
      description: "computed-chain purchases full scan",
    },
    () => assertPurchasesFullScan(fixture, config, phase),
  );

const waitForFullCascade = async (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  phase: ComputedChainPhase,
) => {
  const ordersScan = await waitForOrdersFullScan(fixture, config, phase);
  const purchaseScan = await waitForPurchasesFullScan(fixture, config, phase);
  return { ordersScan, purchaseScan };
};

const waitForFirstAffectedOrder = (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
) => {
  const impact = resolveCascadeImpact(shapeFor(config));
  const seeded = fixture.orderRecords[impact.firstAffectedOrderRow - 1];
  if (!seeded) {
    throw new Error(
      `Missing first affected order ${impact.firstAffectedOrderRow}`,
    );
  }
  return pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 180_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 100,
      description: "first affected order",
    },
    async () => {
      const record = await getRecord(fixture.ordersTableId, seeded.recordId);
      assertOrderFields(
        fixture,
        config,
        impact.firstAffectedOrderRow,
        record.fields,
        "updated",
      );
      return { recordId: seeded.recordId };
    },
  );
};

const createFixture = async (
  baseId: string,
  tableName: string,
  config: ComputedChainMutationCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
  seedCacheInfo: SeedCacheInfo,
): Promise<Fixture> => {
  const ordersTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : tableName;
  const usersTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "users")
    : `${tableName}-users`;
  const purchaseTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "purchase")
    : `${tableName}-purchase`;
  const createdTableIds: string[] = [];

  try {
    const users = await createTable(baseId, {
      name: usersTableName,
      fields: [
        { name: USER_TITLE, type: FieldType.SingleLineText },
        { name: USER_FIRST_NAME, type: FieldType.SingleLineText },
        { name: USER_LAST_NAME, type: FieldType.SingleLineText },
        { name: USER_EMAIL, type: FieldType.SingleLineText },
        {
          name: USER_STATUS,
          type: FieldType.SingleSelect,
          options: { choices: [{ name: "Pending" }, { name: "Paid" }] },
        },
      ],
      records: [],
    });
    createdTableIds.push(users.id);
    const userFields = resolveUserFields(
      (await getFields(users.id)) as NamedField[],
    );
    const userInputs = Array.from({ length: config.userCount }, (_, index) => {
      const row = index + 1;
      const state = buildExpectedUserState(row, {
        mutation: config.mutation,
        phase: "seed",
        targetUserRow: config.targetUserRow,
      });
      return {
        fields: {
          [USER_TITLE]: userTitle(row),
          [USER_FIRST_NAME]: state.firstName,
          [USER_LAST_NAME]: state.lastName,
          [USER_EMAIL]: state.email,
          [USER_STATUS]: state.status,
        },
      };
    });
    const seededUsers = await createRecordsInBatches(
      users.id,
      userInputs,
      config.userBatchSize,
      FieldKeyType.Name,
    );

    const purchase = await createTable(baseId, {
      name: purchaseTableName,
      fields: [{ name: PURCHASE_TITLE, type: FieldType.SingleLineText }],
      records: [],
    });
    createdTableIds.push(purchase.id);
    const purchaseInputs = Array.from(
      { length: purchaseCount(config) },
      (_, index) => ({
        fields: { [PURCHASE_TITLE]: purchaseTitle(index + 1) },
      }),
    );
    const seededPurchases = await createRecordsInBatches(
      purchase.id,
      purchaseInputs,
      config.batchSize,
      FieldKeyType.Name,
    );

    const orders = await createTable(baseId, {
      name: ordersTableName,
      fields: [
        { name: ORDER_TITLE, type: FieldType.SingleLineText },
        {
          name: USER_LINK,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId: users.id,
            isOneWay: true,
          },
        },
        {
          name: PURCHASE_LINK,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId: purchase.id,
            isOneWay: false,
          },
        },
      ],
      records: [],
    });
    createdTableIds.push(orders.id);
    const orderBaseFields = (await getFields(orders.id)) as NamedField[];
    const userLink = resolveNamedField(orderBaseFields, USER_LINK);
    const purchaseLink = resolveNamedField(orderBaseFields, PURCHASE_LINK);
    const reverseOrdersLinkId = purchaseLink.options?.symmetricFieldId;
    if (!reverseOrdersLinkId) {
      throw new Error("purchase_fk is missing symmetricFieldId");
    }

    await createOrderComputedFields(
      perfCase,
      context,
      orders.id,
      users.id,
      userFields,
      userLink.id,
    );
    const orderFieldVos = (await getFields(orders.id)) as NamedField[];
    const orderFields = resolveOrderFields(orderFieldVos);
    await createPurchaseComputedFields(
      perfCase,
      context,
      purchase.id,
      orders.id,
      reverseOrdersLinkId,
      orderFields.formulas[ORDER_CARD],
    );
    const purchaseFields = resolvePurchaseFields(
      (await getFields(purchase.id)) as NamedField[],
    );

    const orderInputs = Array.from(
      { length: config.orderCount },
      (_, index) => {
        const row = index + 1;
        const userRow = userRowForOrder(shapeFor(config), row);
        const purchaseRow = purchaseRowForOrder(shapeFor(config), row);
        const userRecordId = seededUsers.ids[userRow - 1];
        const purchaseRecordId = seededPurchases.ids[purchaseRow - 1];
        if (!userRecordId || !purchaseRecordId) {
          throw new Error(`Missing foreign id for order ${row}`);
        }
        return {
          fields: {
            [ORDER_TITLE]: orderTitle(row),
            [USER_LINK]: { id: userRecordId },
            [PURCHASE_LINK]: { id: purchaseRecordId },
          },
        };
      },
    );
    const seededOrders = await createRecordsInBatches(
      orders.id,
      orderInputs,
      config.batchSize,
      FieldKeyType.Name,
    );

    const profileSeedField = resolveNamedField(orderFieldVos, PROFILE_SEED);
    const profileSeedDependencyIds = extractDependencyIds(
      profileSeedField.options?.expression,
    );
    const metadata: CachedSeed = {
      fixtureVersion: FIXTURE_VERSION,
      userCount: config.userCount,
      orderCount: config.orderCount,
      purchaseCount: purchaseCount(config),
      usersTableId: users.id,
      purchaseTableId: purchase.id,
      userRecordIds: seededUsers.ids,
      orderRecordIds: seededOrders.ids,
      purchaseRecordIds: seededPurchases.ids,
    };
    await updateTableDescription(baseId, orders.id, {
      description: `${METADATA_PREFIX}${JSON.stringify(metadata)}`,
    });

    return {
      usersTableId: users.id,
      ordersTableId: orders.id,
      ordersTableName,
      purchaseTableId: purchase.id,
      userFields,
      orderFields,
      purchaseFields,
      userRecords: seededUsers.ids.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      orderRecords: seededOrders.ids.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      purchaseRecords: seededPurchases.ids.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      profileSeedDependencyIds,
      seedBatchDurations: [
        ...seededUsers.durations,
        ...seededPurchases.durations,
        ...seededOrders.durations,
      ],
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
          `Failed to clean incomplete table ${tableId}`,
          cleanupError,
        );
      }
    }
    throw error;
  }
};

const restoreFixture = async (
  baseId: string,
  config: ComputedChainMutationCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<Fixture | undefined> => {
  if (!seedCacheInfo.enabled) {
    return;
  }
  const cachedOrders = await findSeedTable(baseId, seedCacheInfo.seedTableName);
  if (!cachedOrders) {
    return;
  }
  try {
    const metadata = parseCachedSeed(
      (await getTable(baseId, cachedOrders.id)).description,
    );
    if (
      !metadata ||
      metadata.fixtureVersion !== FIXTURE_VERSION ||
      metadata.userCount !== config.userCount ||
      metadata.orderCount !== config.orderCount ||
      metadata.purchaseCount !== purchaseCount(config) ||
      metadata.userRecordIds.length !== config.userCount ||
      metadata.orderRecordIds.length !== config.orderCount ||
      metadata.purchaseRecordIds.length !== purchaseCount(config)
    ) {
      throw new Error("cached metadata is missing or stale");
    }
    const userFieldVos = (await getFields(
      metadata.usersTableId,
    )) as NamedField[];
    const orderFieldVos = (await getFields(cachedOrders.id)) as NamedField[];
    const purchaseFieldVos = (await getFields(
      metadata.purchaseTableId,
    )) as NamedField[];
    const fixture: Fixture = {
      usersTableId: metadata.usersTableId,
      ordersTableId: cachedOrders.id,
      ordersTableName: cachedOrders.name,
      purchaseTableId: metadata.purchaseTableId,
      userFields: resolveUserFields(userFieldVos),
      orderFields: resolveOrderFields(orderFieldVos),
      purchaseFields: resolvePurchaseFields(purchaseFieldVos),
      userRecords: metadata.userRecordIds.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      orderRecords: metadata.orderRecordIds.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      purchaseRecords: metadata.purchaseRecordIds.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      profileSeedDependencyIds: extractDependencyIds(
        resolveNamedField(orderFieldVos, PROFILE_SEED).options?.expression,
      ),
      seedBatchDurations: [0],
      seedCacheInfo,
      seedCacheHit: true,
      reusableSeed: true,
    };
    await waitForSeedSamples(fixture, config);
    return fixture;
  } catch (error) {
    console.warn(
      `Invalid computed-chain seed ${seedCacheInfo.seedTableName}; rebuilding`,
      error,
    );
    const metadata = parseCachedSeed(
      (await getTable(baseId, cachedOrders.id).catch(() => null))?.description,
    );
    for (const tableId of [
      cachedOrders.id,
      metadata?.usersTableId,
      metadata?.purchaseTableId,
    ]) {
      if (tableId) {
        try {
          await permanentDeleteTable(baseId, tableId);
        } catch (cleanupError) {
          console.warn(`Failed to delete stale table ${tableId}`, cleanupError);
        }
      }
    }
    return;
  }
};

const prepareFixture = async (
  baseId: string,
  tableName: string,
  config: ComputedChainMutationCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
) => {
  resolveCascadeImpact(shapeFor(config));
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "computed-chain-mutation",
    fixtureVersion: FIXTURE_VERSION,
    seedConfig: getSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./computed-chain-mutation-model.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  return (
    (await restoreFixture(baseId, config, seedCacheInfo)) ??
    createFixture(baseId, tableName, config, perfCase, context, seedCacheInfo)
  );
};

const responseRecordCount = (data: unknown) =>
  Array.isArray(data)
    ? data.length
    : ((data as { records?: unknown[] })?.records?.length ?? 0);

const updateForeignCell = async (
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
  phase: ComputedChainPhase,
) => {
  const target = fixture.userRecords[config.targetUserRow - 1];
  if (!target) {
    throw new Error(`Missing target User ${config.targetUserRow}`);
  }
  const state = buildExpectedUserState(config.targetUserRow, {
    mutation: config.mutation,
    phase,
    targetUserRow: config.targetUserRow,
  });
  const fieldId =
    config.mutation === "foreign-select"
      ? fixture.userFields.status
      : fixture.userFields.firstName;
  const value =
    config.mutation === "foreign-select" ? state.status : state.firstName;
  const response = await updateRecords(fixture.usersTableId, {
    fieldKeyType: FieldKeyType.Id,
    typecast: true,
    records: [{ id: target.recordId, fields: { [fieldId]: value } }],
  });
  if (response.status !== 200 || responseRecordCount(response.data) !== 1) {
    throw new Error(
      `Foreign cell update failed: status=${response.status}, updated=${responseRecordCount(response.data)}`,
    );
  }
  return {
    kind: "foreign" as const,
    updatedRecords: 1,
    responseHeaders: pickRoutingResponseHeaders(
      response.headers as Record<string, unknown>,
    ),
  };
};

const updateFormulaExpression = async (
  fixture: Fixture,
  mutation: FormulaMutation,
) => {
  const fieldIdByName = new Map<string, string>([
    [LOOKUP_FIRST_NAME, fixture.orderFields.lookupFirstName],
    [LOOKUP_LAST_NAME, fixture.orderFields.lookupLastName],
    [LOOKUP_EMAIL, fixture.orderFields.lookupEmail],
    [LOOKUP_STATUS, fixture.orderFields.lookupStatus],
  ]);
  const expression = compileExpression(
    updatedProfileSeedExpression(mutation),
    fieldIdByName,
  );
  const expectedDependencyNames = isFormulaDependencyMutation(mutation)
    ? resolveFormulaDependencyPlan(mutation).after
    : [LOOKUP_FIRST_NAME, LOOKUP_LAST_NAME, LOOKUP_STATUS];
  const expectedDependenciesAfter = expectedDependencyNames
    .map((name) => {
      const id = fieldIdByName.get(name);
      if (!id) {
        throw new Error(`Missing formula dependency field ${name}`);
      }
      return id;
    })
    .sort();
  const fieldId = fixture.orderFields.formulas[PROFILE_SEED];
  const response = await apiConvertField(fixture.ordersTableId, fieldId, {
    name: PROFILE_SEED,
    type: FieldType.Formula,
    options: { expression },
  } as Parameters<typeof apiConvertField>[2]);
  if (response.status !== 200) {
    throw new Error(`Formula update failed: status=${response.status}`);
  }
  if (
    response.data.id !== fieldId ||
    response.data.type !== FieldType.Formula
  ) {
    throw new Error(
      `Formula field identity changed: expected=${fieldId}/${FieldType.Formula}, actual=${response.data.id}/${response.data.type}`,
    );
  }
  const currentFields = (await getFields(
    fixture.ordersTableId,
  )) as NamedField[];
  const current = resolveNamedField(currentFields, PROFILE_SEED);
  const dependenciesAfter = extractDependencyIds(current.options?.expression);
  if (
    JSON.stringify(dependenciesAfter) !==
    JSON.stringify(expectedDependenciesAfter)
  ) {
    throw new Error(
      `Formula dependencies mismatch for ${mutation}: expected=${expectedDependenciesAfter.join(",")}, actual=${dependenciesAfter.join(",")}`,
    );
  }
  return {
    kind: "formula" as const,
    convertedField: {
      id: response.data.id,
      name: response.data.name,
      type: response.data.type,
    },
    dependenciesAfter,
    responseHeaders: pickRoutingResponseHeaders(
      response.headers as Record<string, unknown>,
    ),
  };
};

const runMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  config: ComputedChainMutationCaseConfig,
): Promise<Measurement<PrimaryResult>> => {
  let mutationRequestMs = 0;
  let postResponsePropagationMs = 0;
  let responseHeaders: Record<string, string> = {};
  let routing: EngineRouting | undefined;
  let updatedRecords: number | undefined;
  let convertedField: PrimaryResult["convertedField"];
  let dependenciesAfter = [...fixture.profileSeedDependencyIds];
  let firstOrderRecordId: string | undefined;
  let ordersScan: ScanResult = {
    scannedRecords: 0,
    pageSize: 0,
    pageCount: 0,
    affectedRecords: 0,
    unaffectedRecords: 0,
  };
  let purchaseScan: ScanResult = { ...ordersScan };

  const primaryMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, async () => {
        const requestMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          "mutationRequest",
          () =>
            measureAsync<MutationRequestResult>("mutationRequest", async () =>
              isFormulaMutation(config.mutation)
                ? updateFormulaExpression(fixture, config.mutation)
                : updateForeignCell(fixture, config, "updated"),
            ),
        );
        mutationRequestMs = requestMeasurement.durationMs;
        responseHeaders = requestMeasurement.result.responseHeaders;
        if (requestMeasurement.result.kind === "foreign") {
          updatedRecords = requestMeasurement.result.updatedRecords;
        } else {
          convertedField = requestMeasurement.result.convertedField;
          dependenciesAfter = requestMeasurement.result.dependenciesAfter;
        }
        routing = assertEngineRouting(context, responseHeaders, {
          operation: isFormulaMutation(config.mutation)
            ? "convertField"
            : "updateRecords",
          feature: isFormulaMutation(config.mutation)
            ? "convertField"
            : "updateRecords",
        });

        const propagationMeasurement = await measureAsync<PropagationResult>(
          "postResponsePropagation",
          async () => {
            if (isFormulaMutation(config.mutation)) {
              const full = await waitForFullCascade(fixture, config, "updated");
              return { kind: "full-cascade", ...full };
            }
            const first = await waitForFirstAffectedOrder(fixture, config);
            return { kind: "first-order", ...first };
          },
        );
        postResponsePropagationMs = propagationMeasurement.durationMs;
        if (propagationMeasurement.result.kind === "full-cascade") {
          ordersScan = propagationMeasurement.result.ordersScan;
          purchaseScan = propagationMeasurement.result.purchaseScan;
        } else {
          firstOrderRecordId = propagationMeasurement.result.recordId;
        }
      }),
  );

  let fullOrdersVerificationMs = 0;
  let purchaseVerificationMs = 0;
  if (!isFormulaMutation(config.mutation)) {
    const fullOrdersMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "allAffectedOrdersReady",
      () =>
        measureAsync("allAffectedOrdersReady", () =>
          waitForOrdersFullScan(fixture, config, "updated"),
        ),
    );
    fullOrdersVerificationMs = fullOrdersMeasurement.durationMs;
    ordersScan = fullOrdersMeasurement.result;

    const purchaseMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      "purchaseCascadeReady",
      () =>
        measureAsync("purchaseCascadeReady", () =>
          waitForPurchasesFullScan(fixture, config, "updated"),
        ),
    );
    purchaseVerificationMs = purchaseMeasurement.durationMs;
    purchaseScan = purchaseMeasurement.result;
  }

  if (!routing) {
    throw new Error("Mutation completed without routing evidence");
  }
  return {
    ...primaryMeasurement,
    result: {
      mutationRequestMs,
      ...(isFormulaMutation(config.mutation)
        ? { formulaUpdateMs: mutationRequestMs }
        : { sourceWriteMs: mutationRequestMs }),
      postResponsePropagationMs,
      allAffectedOrdersReadyMs: roundMetric(
        primaryMeasurement.durationMs + fullOrdersVerificationMs,
      ),
      purchaseCascadeReadyMs: roundMetric(
        primaryMeasurement.durationMs +
          fullOrdersVerificationMs +
          purchaseVerificationMs,
      ),
      responseHeaders,
      routing,
      updatedRecords,
      convertedField,
      dependenciesBefore: fixture.profileSeedDependencyIds,
      dependenciesAfter,
      firstOrderRecordId,
      ordersScan,
      purchaseScan,
      fullOrdersVerificationMs,
      purchaseVerificationMs,
    },
  };
};

const buildResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  primaryMeasurement,
  error,
}: {
  config: ComputedChainMutationCaseConfig;
  fixture?: Fixture;
  prepareMeasurement?: Measurement<Fixture>;
  seedReadyMeasurement?: Measurement<{
    checkedOrders: number;
    checkedPurchases: number;
  }>;
  primaryMeasurement?: Measurement<PrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const primary = primaryMeasurement?.result;
  const impact = resolveCascadeImpact(shapeFor(config));
  return {
    metrics: {
      ...(prepareMeasurement
        ? { prepareMs: prepareMeasurement.durationMs }
        : {}),
      ...(seedReadyMeasurement
        ? { seedReadyMs: seedReadyMeasurement.durationMs }
        : {}),
      ...(fixture
        ? {
            seedCacheHit: fixture.seedCacheHit ? 1 : 0,
            seedCacheEnabled: fixture.seedCacheInfo.enabled ? 1 : 0,
            maxSeedBatchMs: fixture.seedBatchDurations.length
              ? roundMetric(Math.max(...fixture.seedBatchDurations))
              : 0,
          }
        : {}),
      ...(primaryMeasurement && primary
        ? {
            [config.threshold.metric]: primaryMeasurement.durationMs,
            mutationRequestMs: primary.mutationRequestMs,
            ...(primary.sourceWriteMs != null
              ? { sourceWriteMs: primary.sourceWriteMs }
              : {}),
            ...(primary.formulaUpdateMs != null
              ? { formulaUpdateMs: primary.formulaUpdateMs }
              : {}),
            postResponsePropagationMs: primary.postResponsePropagationMs,
            allAffectedOrdersReadyMs: primary.allAffectedOrdersReadyMs,
            purchaseCascadeReadyMs: primary.purchaseCascadeReadyMs,
            fullOrdersVerificationMs: primary.fullOrdersVerificationMs,
            purchaseVerificationMs: primary.purchaseVerificationMs,
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
            ...(config.verify.maxPostResponseMs != null
              ? [
                  {
                    metric: "postResponsePropagationMs",
                    max: config.verify.maxPostResponseMs,
                    unit: "ms",
                  },
                ]
              : []),
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
      ...(primary?.fullOrdersVerificationMs
        ? [
            {
              name: "allAffectedOrdersReady",
              durationMs: primary.fullOrdersVerificationMs,
            },
          ]
        : []),
      ...(primary?.purchaseVerificationMs
        ? [
            {
              name: "purchaseCascadeReady",
              durationMs: primary.purchaseVerificationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: config.mutation,
      fixture: fixture
        ? {
            usersTableId: fixture.usersTableId,
            ordersTableId: fixture.ordersTableId,
            ordersTableName: fixture.ordersTableName,
            purchaseTableId: fixture.purchaseTableId,
            userCount: config.userCount,
            orderCount: config.orderCount,
            purchaseCount: purchaseCount(config),
            formulaDepth: FORMULA_NAMES.length,
            seedCache: {
              enabled: fixture.seedCacheInfo.enabled,
              cacheHit: fixture.seedCacheHit,
              reusable: fixture.reusableSeed,
              seedHash: fixture.seedCacheInfo.seedHash,
              seedTableName: fixture.seedCacheInfo.seedTableName,
              schemaSignature: fixture.seedCacheInfo.schemaSignature,
            },
          }
        : undefined,
      impact,
      request: fixture
        ? isFormulaMutation(config.mutation)
          ? {
              method: "PUT",
              path: `/api/table/${fixture.ordersTableId}/field/${fixture.orderFields.formulas[PROFILE_SEED]}/convert`,
              changedFieldCount: 1,
              dependencyGraphChanged: isFormulaDependencyMutation(
                config.mutation,
              ),
            }
          : {
              method: "PATCH",
              path: `/api/table/${fixture.usersTableId}/record`,
              changedRecordCount: 1,
              changedFieldCount: 1,
              linksChanged: false,
            }
        : undefined,
      routing: primary?.routing,
      responseHeaders: primary?.responseHeaders,
      updatedRecords: primary?.updatedRecords,
      convertedField: primary?.convertedField,
      dependencies: primary
        ? {
            before: primary.dependenciesBefore,
            after: primary.dependenciesAfter,
            added: primary.dependenciesAfter.filter(
              (id) => !primary.dependenciesBefore.includes(id),
            ),
            removed: primary.dependenciesBefore.filter(
              (id) => !primary.dependenciesAfter.includes(id),
            ),
            unchanged:
              JSON.stringify(primary.dependenciesBefore) ===
              JSON.stringify(primary.dependenciesAfter),
            logical: isFormulaDependencyMutation(config.mutation)
              ? resolveFormulaDependencyPlan(config.mutation)
              : undefined,
          }
        : undefined,
      firstOrderRecordId: primary?.firstOrderRecordId,
      scans: primary
        ? { orders: primary.ordersScan, purchases: primary.purchaseScan }
        : undefined,
      seedReady: seedReadyMeasurement?.result,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    },
  };
};

const cleanupFixture = async ({
  baseId,
  fixture,
  config,
}: {
  baseId: string;
  fixture: Fixture | undefined;
  config: ComputedChainMutationCaseConfig;
}) => {
  if (!fixture || isExecuteDbIsolated()) {
    return;
  }
  if (!fixture.reusableSeed || isFormulaMutation(config.mutation)) {
    await deleteFixtureTables(baseId, fixture);
    return;
  }
  try {
    await updateForeignCell(fixture, config, "seed");
    await waitForSeedSamples(fixture, config);
  } catch (error) {
    console.warn(
      `Failed to restore computed-chain seed ${fixture.ordersTableId}; deleting it`,
      error,
    );
    await deleteFixtureTables(baseId, fixture);
  }
};

const lifecycleSpec: RecordMutationLifecycleSpec<
  ComputedChainMutationCaseConfig,
  Fixture,
  { checkedOrders: number; checkedPurchases: number },
  PrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase, context }) =>
    prepareFixture(baseId, tableName, config, perfCase, context),
  assertSeedReady: ({ fixture, config }) => waitForSeedSamples(fixture, config),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runMeasuredOperation(perfCase, context, fixture, config),
  buildResult,
  cleanup: cleanupFixture,
};

export const runComputedChainMutationCase = async (
  perfCase: PerfCaseFor<"computed-chain-mutation">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, lifecycleSpec);

export const seedComputedChainMutationCase = async (
  perfCase: PerfCaseFor<"computed-chain-mutation">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, lifecycleSpec);
