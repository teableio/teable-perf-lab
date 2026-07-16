import { performance } from "node:perf_hooks";
import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import {
  createRecords as apiCreateRecords,
  getRecords as apiGetRecords,
  updateRecords as apiUpdateRecords,
  updateTableDescription,
} from "@teable/openapi";
import {
  createField,
  createRecords,
  createTable,
  deleteRecords,
  getFields,
  getRecords,
  getTable,
  permanentDeleteTable,
} from "../../../utils/init-app";
import {
  ComputedOutboxObserver,
  type ComputedOutboxObserverSummary,
} from "../computed-outbox-observer";
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
import {
  PerfRunDiagnosticError,
  type CustomerUpsertComputedFlowCaseConfig,
  type PerfCase,
  type PerfCaseFor,
  type PerfRunContext,
  type PerfRunResult,
} from "../types";
import {
  buildExpectedOrderState,
  buildOrderValues,
  buildUserState,
  createdOrderRow,
  createdUserRow,
  finalOrderCount,
  finalUserCount,
  FORMULA_NAMES,
  isAffectedOrder,
  isAffectedPurchase,
  isOrderCreateScenario,
  isUserCreateScenario,
  ORDER_VALUE_NAMES,
  orderTitle,
  purchaseChildOrderRows,
  purchaseTitle,
  resolveCachedCompanionTableIds,
  resolveImpact,
  targetOrderRow,
  targetPurchaseRow,
  USER_ATTRIBUTE_NAMES,
  userRowForOrder,
  userTitle,
  type CustomerUpsertFixtureShape,
  type CustomerUpsertPhase,
  type FormulaName,
  type OrderValueName,
  type UserAttributeName,
} from "./customer-upsert-computed-flow-model";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const FIXTURE_VERSION = "customer-upsert-computed-flow-v1";
const METADATA_PREFIX = "perf-lab-customer-upsert-computed-flow:";

const USER_TITLE = "Key";
const ORDER_USER_LINK = "customer_id_fk";
const ORDER_PURCHASE_LINK = "purchase_fk";
const PURCHASE_TITLE = "Title";
const PURCHASE_CARDS = "p_cards";
const PURCHASE_LABEL = "p_label";

type NamedField = {
  id: string;
  name: string;
  type?: string;
  options?: { symmetricFieldId?: string };
};

type UserFieldIds = {
  title: string;
  attributes: Record<UserAttributeName, string>;
};

type OrderFieldIds = {
  values: Record<OrderValueName, string>;
  userLink: string;
  purchaseLink: string;
  lookups: Record<UserAttributeName, string>;
  formulas: Record<FormulaName, string>;
};

type PurchaseFieldIds = {
  title: string;
  cards: string;
  label: string;
};

type SeededRecord = { rowNumber: number; recordId: string };

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

type ExecuteState = {
  createdUserRecordId?: string;
  createdOrderRecordId?: string;
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
  seedBatchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
  executeState: ExecuteState;
};

type ScanResult = {
  scannedRecords: number;
  pageSize: number;
  pageCount: number;
  affectedRecords: number;
  unaffectedRecords: number;
};

type SeedReadyResult = {
  users: ScanResult;
  orders: ScanResult;
  purchases: ScanResult;
};

type WriteEvidence = {
  method: "POST" | "PATCH";
  tableId: string;
  recordId: string;
  status: number;
  requestedRecords: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type FirstReadState = "null" | "old" | "mixed" | "correct";

type TargetReadEvidence = {
  recordId: string;
  attempts: number;
  firstRead: {
    state: FirstReadState;
    elapsedMs: number;
    matchingCells: number;
    totalCells: number;
  };
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
};

type PrimaryResult = {
  userWriteMs?: number;
  orderWriteMs?: number;
  postOrderResponseReadyMs?: number;
  userWrite?: WriteEvidence;
  orderWrite?: WriteEvidence;
  targetRead?: TargetReadEvidence;
  usersScan?: ScanResult;
  ordersScan?: ScanResult;
  purchasesScan?: ScanResult;
  usersVerificationMs?: number;
  ordersVerificationMs?: number;
  purchasesVerificationMs?: number;
  outbox?: ComputedOutboxObserverSummary;
  outboxError?: string;
};

const shapeFor = (
  config: CustomerUpsertComputedFlowCaseConfig,
): CustomerUpsertFixtureShape => ({
  userCount: config.userCount,
  orderCount: config.orderCount,
  ordersPerUser: config.ordersPerUser,
  purchaseGroupSize: config.purchaseGroupSize,
  targetUserRow: config.targetUserRow,
});

const purchaseCount = (config: CustomerUpsertComputedFlowCaseConfig) =>
  config.orderCount / config.purchaseGroupSize;

const lookupName = (attribute: UserAttributeName) => `lookup_${attribute}`;

const resolveNamedField = (fields: NamedField[], name: string) => {
  const field = fields.find((candidate) => candidate.name === name);
  if (!field) {
    throw new Error(
      `Missing field ${name}; available=${fields.map((field) => field.name).join(",")}`,
    );
  }
  return field;
};

const resolveUserFields = (fields: NamedField[]): UserFieldIds => ({
  title: resolveNamedField(fields, USER_TITLE).id,
  attributes: Object.fromEntries(
    USER_ATTRIBUTE_NAMES.map((name) => [
      name,
      resolveNamedField(fields, name).id,
    ]),
  ) as UserFieldIds["attributes"],
});

const resolveOrderFields = (fields: NamedField[]): OrderFieldIds => ({
  values: Object.fromEntries(
    ORDER_VALUE_NAMES.map((name) => [name, resolveNamedField(fields, name).id]),
  ) as OrderFieldIds["values"],
  userLink: resolveNamedField(fields, ORDER_USER_LINK).id,
  purchaseLink: resolveNamedField(fields, ORDER_PURCHASE_LINK).id,
  lookups: Object.fromEntries(
    USER_ATTRIBUTE_NAMES.map((name) => [
      name,
      resolveNamedField(fields, lookupName(name)).id,
    ]),
  ) as OrderFieldIds["lookups"],
  formulas: Object.fromEntries(
    FORMULA_NAMES.map((name) => [name, resolveNamedField(fields, name).id]),
  ) as OrderFieldIds["formulas"],
});

const resolvePurchaseFields = (fields: NamedField[]): PurchaseFieldIds => ({
  title: resolveNamedField(fields, PURCHASE_TITLE).id,
  cards: resolveNamedField(fields, PURCHASE_CARDS).id,
  label: resolveNamedField(fields, PURCHASE_LABEL).id,
});

const normalizeValue = (value: unknown): string => {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(normalizeValue).join(",");
  if (typeof value === "object") {
    const object = value as { id?: unknown; title?: unknown; name?: unknown };
    if (typeof object.title === "string") return object.title;
    if (typeof object.name === "string") return object.name;
    if (typeof object.id === "string") return object.id;
  }
  return String(value);
};

const normalizeLinkIds = (value: unknown): string[] => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(normalizeLinkIds);
  if (typeof value === "object") {
    const id = (value as { id?: unknown }).id;
    return typeof id === "string" ? [id] : [];
  }
  return [];
};

const compileExpression = (
  expression: string,
  fieldIdByName: Map<string, string>,
) =>
  expression.replace(/\{([^}]+)\}/g, (match, name: string) => {
    const id = fieldIdByName.get(name);
    return id ? `{${id}}` : match;
  });

const formulaDefinitions = () => [
  {
    name: "profile_seed" as const,
    expression: [
      `{status}`,
      ...USER_ATTRIBUTE_NAMES.map((name) => `{${lookupName(name)}}`),
    ].join(' & "|" & '),
  },
  { name: "profile_l2" as const, expression: `{profile_seed} & "|L2"` },
  { name: "profile_l3" as const, expression: `{profile_l2} & "|L3"` },
  { name: "profile_l4" as const, expression: `{profile_l3} & "|L4"` },
  {
    name: "order_card" as const,
    expression: `"ORDER " & {Title} & "|" & {profile_l4} & "|L5"`,
  },
];

const parseRowNumber = (value: unknown, prefix: string) => {
  const text = normalizeValue(value);
  if (!text.startsWith(prefix)) {
    throw new Error(`Expected ${prefix}<row>, got ${text}`);
  }
  const row = Number(text.slice(prefix.length));
  if (!Number.isInteger(row) || row <= 0) {
    throw new Error(`Expected integer row in ${text}`);
  }
  return row;
};

const safeErrorSummary = (error: unknown) => {
  const code =
    error instanceof Error ? (error as Error & { code?: unknown }).code : null;
  return {
    name: error instanceof Error ? error.name : "UnknownError",
    message:
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "Unknown error",
    ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
  };
};

const parseCachedSeed = (
  description: string | null | undefined,
): CachedSeed | undefined => {
  if (!description?.startsWith(METADATA_PREFIX)) return;
  try {
    return JSON.parse(description.slice(METADATA_PREFIX.length)) as CachedSeed;
  } catch {
    return;
  }
};

const getSeedConfig = (config: CustomerUpsertComputedFlowCaseConfig) => ({
  baseId: config.baseId,
  userCount: config.userCount,
  orderCount: config.orderCount,
  ordersPerUser: config.ordersPerUser,
  purchaseGroupSize: config.purchaseGroupSize,
  targetUserRow: config.targetUserRow,
  batchSize: config.batchSize,
  userBatchSize: config.userBatchSize,
  userAttributes: [...USER_ATTRIBUTE_NAMES],
  orderValues: [...ORDER_VALUE_NAMES],
  lookupCount: USER_ATTRIBUTE_NAMES.length,
  formulas: formulaDefinitions(),
  fixtureVersion: FIXTURE_VERSION,
});

const createRecordsInBatches = async (
  tableId: string,
  records: Array<{ fields: Record<string, unknown> }>,
  batchSize: number,
) => {
  const ids: string[] = [];
  const durations: number[] = [];
  for (const batch of chunk(records, batchSize)) {
    const measurement = await measureAsync("seedBatch", () =>
      createRecords(tableId, {
        fieldKeyType: FieldKeyType.Name,
        typecast: true,
        records: batch,
      }),
    );
    if (measurement.result.records.length !== batch.length) {
      throw new Error(
        `Seed batch mismatch: expected=${batch.length}, actual=${measurement.result.records.length}`,
      );
    }
    ids.push(...measurement.result.records.map((record) => record.id));
    durations.push(measurement.durationMs);
  }
  return { ids, durations };
};

const buildUserPayload = (
  config: CustomerUpsertComputedFlowCaseConfig,
  row: number,
  phase: CustomerUpsertPhase,
) => ({
  [USER_TITLE]: userTitle(row),
  ...buildUserState(row, {
    shape: shapeFor(config),
    scenario: config.scenario,
    phase,
  }),
});

const buildOrderPayload = (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  row: number,
  phase: CustomerUpsertPhase,
) => {
  const shape = shapeFor(config);
  const userRow = userRowForOrder(shape, config.scenario, row);
  const purchaseRow =
    phase === "seed"
      ? Math.ceil(row / config.purchaseGroupSize)
      : buildExpectedOrderState(shape, config.scenario, row, phase).purchaseRow;
  const userRecordId =
    userRow <= config.userCount
      ? fixture.userRecords[userRow - 1]?.recordId
      : fixture.executeState.createdUserRecordId;
  const purchaseRecordId = fixture.purchaseRecords[purchaseRow - 1]?.recordId;
  if (!userRecordId || !purchaseRecordId) {
    throw new Error(
      `Missing link target for order=${row}, user=${userRow}, purchase=${purchaseRow}`,
    );
  }
  return {
    ...buildOrderValues(row, {
      shape,
      scenario: config.scenario,
      phase,
    }),
    [ORDER_USER_LINK]: { id: userRecordId },
    [ORDER_PURCHASE_LINK]: { id: purchaseRecordId },
  };
};

const createOrderComputedFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixtureInput: {
    usersTableId: string;
    ordersTableId: string;
    userFields: UserFieldIds;
    userLinkFieldId: string;
  },
) => {
  for (const attribute of USER_ATTRIBUTE_NAMES) {
    await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createLookup:${lookupName(attribute)}`,
      () =>
        createField(fixtureInput.ordersTableId, {
          name: lookupName(attribute),
          type: FieldType.SingleLineText,
          isLookup: true,
          lookupOptions: {
            foreignTableId: fixtureInput.usersTableId,
            linkFieldId: fixtureInput.userLinkFieldId,
            lookupFieldId: fixtureInput.userFields.attributes[attribute],
          },
        }),
    );
  }
  const fields = (await getFields(fixtureInput.ordersTableId)) as NamedField[];
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  for (const formula of formulaDefinitions()) {
    const created = await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createFormula:${formula.name}`,
      () =>
        createField(fixtureInput.ordersTableId, {
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
  input: {
    purchaseTableId: string;
    ordersTableId: string;
    reverseOrdersLinkId: string;
    orderCardFieldId: string;
  },
) => {
  await withPerfTraceStep(
    context,
    perfCase,
    `seedBuild:createRollup:${PURCHASE_CARDS}`,
    () =>
      createField(input.purchaseTableId, {
        name: PURCHASE_CARDS,
        type: FieldType.Rollup,
        options: { expression: "array_join({values})" },
        lookupOptions: {
          foreignTableId: input.ordersTableId,
          linkFieldId: input.reverseOrdersLinkId,
          lookupFieldId: input.orderCardFieldId,
        },
      }),
  );
  const fields = (await getFields(input.purchaseTableId)) as NamedField[];
  const fieldIdByName = new Map(fields.map((field) => [field.name, field.id]));
  await withPerfTraceStep(
    context,
    perfCase,
    `seedBuild:createFormula:${PURCHASE_LABEL}`,
    () =>
      createField(input.purchaseTableId, {
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
      console.warn(
        `Failed to delete customer-upsert table ${tableId}`,
        safeErrorSummary(error),
      );
    }
  }
};

const createFixture = async (
  baseId: string,
  tableName: string,
  config: CustomerUpsertComputedFlowCaseConfig,
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
    ? buildSeedTableName(seedCacheInfo, "purchases")
    : `${tableName}-purchases`;
  const createdTableIds: string[] = [];

  try {
    const users = await createTable(baseId, {
      name: usersTableName,
      fields: [
        { name: USER_TITLE, type: FieldType.SingleLineText },
        ...USER_ATTRIBUTE_NAMES.map((name) => ({
          name,
          type: FieldType.SingleLineText,
        })),
      ],
      records: [],
    });
    createdTableIds.push(users.id);
    const userFields = resolveUserFields(
      (await getFields(users.id)) as NamedField[],
    );
    const seededUsers = await createRecordsInBatches(
      users.id,
      Array.from({ length: config.userCount }, (_, index) => ({
        fields: buildUserPayload(config, index + 1, "seed"),
      })),
      config.userBatchSize,
    );

    const purchases = await createTable(baseId, {
      name: purchaseTableName,
      fields: [{ name: PURCHASE_TITLE, type: FieldType.SingleLineText }],
      records: [],
    });
    createdTableIds.push(purchases.id);
    const seededPurchases = await createRecordsInBatches(
      purchases.id,
      Array.from({ length: purchaseCount(config) }, (_, index) => ({
        fields: { [PURCHASE_TITLE]: purchaseTitle(index + 1) },
      })),
      config.batchSize,
    );

    const orders = await createTable(baseId, {
      name: ordersTableName,
      fields: [
        { name: "Title", type: FieldType.SingleLineText },
        {
          name: "status",
          type: FieldType.SingleSelect,
          options: { choices: [{ name: "Pending" }, { name: "Paid" }] },
        },
        { name: "currency", type: FieldType.SingleLineText },
        { name: "total", type: FieldType.Number },
        { name: "customer_note", type: FieldType.SingleLineText },
        { name: "payment_method", type: FieldType.SingleLineText },
        { name: "transaction_id", type: FieldType.SingleLineText },
        { name: "customer_ip_address", type: FieldType.SingleLineText },
        { name: "created_via", type: FieldType.SingleLineText },
        { name: "order_number", type: FieldType.SingleLineText },
        {
          name: ORDER_USER_LINK,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId: users.id,
            isOneWay: true,
          },
        },
        {
          name: ORDER_PURCHASE_LINK,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId: purchases.id,
            isOneWay: false,
          },
        },
      ],
      records: [],
    });
    createdTableIds.push(orders.id);
    const baseOrderFields = (await getFields(orders.id)) as NamedField[];
    const userLink = resolveNamedField(baseOrderFields, ORDER_USER_LINK);
    const purchaseLink = resolveNamedField(
      baseOrderFields,
      ORDER_PURCHASE_LINK,
    );
    const reverseOrdersLinkId = purchaseLink.options?.symmetricFieldId;
    if (!reverseOrdersLinkId) {
      throw new Error("purchase_fk is missing symmetricFieldId");
    }
    await createOrderComputedFields(perfCase, context, {
      usersTableId: users.id,
      ordersTableId: orders.id,
      userFields,
      userLinkFieldId: userLink.id,
    });
    const orderFields = resolveOrderFields(
      (await getFields(orders.id)) as NamedField[],
    );
    await createPurchaseComputedFields(perfCase, context, {
      purchaseTableId: purchases.id,
      ordersTableId: orders.id,
      reverseOrdersLinkId,
      orderCardFieldId: orderFields.formulas.order_card,
    });
    const purchaseFields = resolvePurchaseFields(
      (await getFields(purchases.id)) as NamedField[],
    );

    const fixture: Fixture = {
      usersTableId: users.id,
      ordersTableId: orders.id,
      ordersTableName,
      purchaseTableId: purchases.id,
      userFields,
      orderFields,
      purchaseFields,
      userRecords: seededUsers.ids.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      orderRecords: [],
      purchaseRecords: seededPurchases.ids.map((recordId, index) => ({
        rowNumber: index + 1,
        recordId,
      })),
      seedBatchDurations: [
        ...seededUsers.durations,
        ...seededPurchases.durations,
      ],
      seedCacheInfo,
      seedCacheHit: false,
      reusableSeed: seedCacheInfo.enabled,
      executeState: {},
    };
    const seededOrders = await createRecordsInBatches(
      orders.id,
      Array.from({ length: config.orderCount }, (_, index) => ({
        fields: buildOrderPayload(fixture, config, index + 1, "seed"),
      })),
      config.batchSize,
    );
    fixture.orderRecords = seededOrders.ids.map((recordId, index) => ({
      rowNumber: index + 1,
      recordId,
    }));
    fixture.seedBatchDurations.push(...seededOrders.durations);

    const metadata: CachedSeed = {
      fixtureVersion: FIXTURE_VERSION,
      userCount: config.userCount,
      orderCount: config.orderCount,
      purchaseCount: purchaseCount(config),
      usersTableId: users.id,
      purchaseTableId: purchases.id,
      userRecordIds: seededUsers.ids,
      orderRecordIds: seededOrders.ids,
      purchaseRecordIds: seededPurchases.ids,
    };
    await updateTableDescription(baseId, orders.id, {
      description: `${METADATA_PREFIX}${JSON.stringify(metadata)}`,
    });
    return fixture;
  } catch (error) {
    for (const tableId of createdTableIds.reverse()) {
      try {
        await permanentDeleteTable(baseId, tableId);
      } catch (cleanupError) {
        console.warn(
          `Failed to clean incomplete table ${tableId}`,
          safeErrorSummary(cleanupError),
        );
      }
    }
    throw error;
  }
};

const restoreFixture = async (
  baseId: string,
  config: CustomerUpsertComputedFlowCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<Fixture | undefined> => {
  if (!seedCacheInfo.enabled) return;
  const orders = await findSeedTable(baseId, seedCacheInfo.seedTableName);
  if (!orders) return;
  const companionTableNames = [
    buildSeedTableName(seedCacheInfo, "users"),
    buildSeedTableName(seedCacheInfo, "purchases"),
  ];
  try {
    const [users, purchases] = await Promise.all(
      companionTableNames.map((name) => findSeedTable(baseId, name)),
    );
    const metadata = parseCachedSeed(
      (await getTable(baseId, orders.id)).description,
    );
    if (
      !metadata ||
      !users ||
      !purchases ||
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
    const companionIds = resolveCachedCompanionTableIds({
      metadataUsersTableId: metadata.usersTableId,
      metadataPurchaseTableId: metadata.purchaseTableId,
      discoveredUsersTableId: users.id,
      discoveredPurchaseTableId: purchases.id,
    });
    return {
      usersTableId: companionIds.usersTableId,
      ordersTableId: orders.id,
      ordersTableName: orders.name,
      purchaseTableId: companionIds.purchaseTableId,
      userFields: resolveUserFields(
        (await getFields(users.id)) as NamedField[],
      ),
      orderFields: resolveOrderFields(
        (await getFields(orders.id)) as NamedField[],
      ),
      purchaseFields: resolvePurchaseFields(
        (await getFields(purchases.id)) as NamedField[],
      ),
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
      seedBatchDurations: [0],
      seedCacheInfo,
      seedCacheHit: true,
      reusableSeed: true,
      executeState: {},
    };
  } catch (error) {
    console.warn(
      `Invalid customer-upsert seed ${seedCacheInfo.seedTableName}; rebuilding`,
      safeErrorSummary(error),
    );
    const companionTables = await Promise.all(
      companionTableNames.map(async (name) => {
        try {
          return await findSeedTable(baseId, name);
        } catch (companionError) {
          console.warn(
            `Failed to resolve stale companion table ${name}`,
            safeErrorSummary(companionError),
          );
          return undefined;
        }
      }),
    );
    for (const table of [orders, ...companionTables]) {
      if (table) {
        try {
          await permanentDeleteTable(baseId, table.id);
        } catch (cleanupError) {
          console.warn(
            `Failed to delete stale table ${table.id}`,
            safeErrorSummary(cleanupError),
          );
        }
      }
    }
    return;
  }
};

const prepareFixture = async (
  baseId: string,
  tableName: string,
  config: CustomerUpsertComputedFlowCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
) => {
  const shape = shapeFor(config);
  if (
    config.orderCount !== config.userCount * config.ordersPerUser ||
    config.orderCount % config.purchaseGroupSize !== 0
  ) {
    throw new Error(
      "Customer upsert fixture counts do not form exact fanout groups",
    );
  }
  resolveImpact(shape, config.scenario);
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "customer-upsert-computed-flow",
    fixtureVersion: FIXTURE_VERSION,
    seedConfig: getSeedConfig(config),
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("./customer-upsert-computed-flow-model.ts", import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
    ],
  });
  return (
    (await restoreFixture(baseId, config, seedCacheInfo)) ??
    createFixture(baseId, tableName, config, perfCase, context, seedCacheInfo)
  );
};

const userProjection = (fixture: Fixture) => [
  fixture.userFields.title,
  ...USER_ATTRIBUTE_NAMES.map((name) => fixture.userFields.attributes[name]),
];

const orderProjection = (fixture: Fixture) => [
  ...ORDER_VALUE_NAMES.map((name) => fixture.orderFields.values[name]),
  fixture.orderFields.userLink,
  fixture.orderFields.purchaseLink,
  ...USER_ATTRIBUTE_NAMES.map((name) => fixture.orderFields.lookups[name]),
  ...FORMULA_NAMES.map((name) => fixture.orderFields.formulas[name]),
];

const assertUserFields = (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  row: number,
  fields: Record<string, unknown>,
  phase: CustomerUpsertPhase,
) => {
  const expected = buildUserState(row, {
    shape: shapeFor(config),
    scenario: config.scenario,
    phase,
  });
  for (const name of USER_ATTRIBUTE_NAMES) {
    const actual = normalizeValue(fields[fixture.userFields.attributes[name]]);
    if (actual !== expected[name]) {
      throw new Error(
        `User ${row} ${name} mismatch: expected=${expected[name]}, actual=${actual}`,
      );
    }
  }
};

const expectedUserRecordId = (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  row: number,
  phase: CustomerUpsertPhase,
) => {
  const userRow = userRowForOrder(shapeFor(config), config.scenario, row);
  if (phase === "final" && userRow === createdUserRow(shapeFor(config))) {
    return fixture.executeState.createdUserRecordId;
  }
  return fixture.userRecords[userRow - 1]?.recordId;
};

const assertOrderFields = (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  row: number,
  fields: Record<string, unknown>,
  phase: CustomerUpsertPhase,
) => {
  const expected = buildExpectedOrderState(
    shapeFor(config),
    config.scenario,
    row,
    phase,
  );
  for (const name of ORDER_VALUE_NAMES) {
    const actual = normalizeValue(fields[fixture.orderFields.values[name]]);
    if (actual !== String(expected.orderValues[name])) {
      throw new Error(
        `Order ${row} ${name} mismatch: expected=${expected.orderValues[name]}, actual=${actual}`,
      );
    }
  }
  const expectedUserId = expectedUserRecordId(fixture, config, row, phase);
  const expectedPurchaseId =
    fixture.purchaseRecords[expected.purchaseRow - 1]?.recordId;
  if (!expectedUserId || !expectedPurchaseId) {
    throw new Error(`Missing expected links for Order ${row}`);
  }
  const actualUserIds = normalizeLinkIds(fields[fixture.orderFields.userLink]);
  const actualPurchaseIds = normalizeLinkIds(
    fields[fixture.orderFields.purchaseLink],
  );
  if (
    actualUserIds.length !== 1 ||
    actualUserIds[0] !== expectedUserId ||
    actualPurchaseIds.length !== 1 ||
    actualPurchaseIds[0] !== expectedPurchaseId
  ) {
    throw new Error(
      `Order ${row} links mismatch: user=${actualUserIds.join(",")}/${expectedUserId}, purchase=${actualPurchaseIds.join(",")}/${expectedPurchaseId}`,
    );
  }
  for (const name of USER_ATTRIBUTE_NAMES) {
    const actual = normalizeValue(fields[fixture.orderFields.lookups[name]]);
    if (actual !== expected.lookups[name]) {
      throw new Error(
        `Order ${row} ${lookupName(name)} mismatch: expected=${expected.lookups[name]}, actual=${actual}`,
      );
    }
  }
  for (const name of FORMULA_NAMES) {
    const actual = normalizeValue(fields[fixture.orderFields.formulas[name]]);
    if (actual !== expected.formulas[name]) {
      throw new Error(
        `Order ${row} ${name} mismatch: expected=${expected.formulas[name]}, actual=${actual}`,
      );
    }
  }
};

const assertPurchaseFields = (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  row: number,
  fields: Record<string, unknown>,
  phase: CustomerUpsertPhase,
) => {
  const cards = normalizeValue(fields[fixture.purchaseFields.cards]);
  const label = normalizeValue(fields[fixture.purchaseFields.label]);
  const prefix = `PURCHASE ${purchaseTitle(row)}::`;
  if (label !== `${prefix}${cards}`) {
    throw new Error(
      `Purchase ${row} label mismatch: expected=${prefix}${cards}, actual=${label}`,
    );
  }
  const childRows = purchaseChildOrderRows(
    shapeFor(config),
    config.scenario,
    row,
    phase,
  );
  const observedCards = cards.split("ORDER ").length - 1;
  if (observedCards !== childRows.length) {
    throw new Error(
      `Purchase ${row} card count mismatch: expected=${childRows.length}, actual=${observedCards}`,
    );
  }
  for (const orderRow of childRows) {
    const expectedCard = buildExpectedOrderState(
      shapeFor(config),
      config.scenario,
      orderRow,
      phase,
    ).formulas.order_card;
    if (!cards.includes(expectedCard)) {
      throw new Error(
        `Purchase ${row} rollup missing Order ${orderRow}: ${expectedCard}`,
      );
    }
  }
};

const assertUsersFullScan = async (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  phase: CustomerUpsertPhase,
): Promise<ScanResult> => {
  const totalRows =
    phase === "seed"
      ? config.userCount
      : finalUserCount(shapeFor(config), config.scenario);
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const seen = new Set<number>();
  let affectedRecords = 0;
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows,
      pageSize,
      pageNoun: "users",
      fetchPage: (skip, take) =>
        getRecords(fixture.usersTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: userProjection(fixture),
          skip,
          take,
        }),
    },
    (record) => {
      const row = parseRowNumber(
        record.fields[fixture.userFields.title],
        "User-",
      );
      if (seen.has(row)) throw new Error(`Duplicate User ${row}`);
      seen.add(row);
      assertUserFields(fixture, config, row, record.fields, phase);
      const affected =
        phase === "final" &&
        (row === config.targetUserRow ||
          (isUserCreateScenario(config.scenario) &&
            row === createdUserRow(shapeFor(config))));
      if (affected) affectedRecords += 1;
    },
  );
  return {
    scannedRecords,
    pageSize,
    pageCount,
    affectedRecords,
    unaffectedRecords: scannedRecords - affectedRecords,
  };
};

const assertOrdersFullScan = async (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  phase: CustomerUpsertPhase,
): Promise<ScanResult> => {
  const totalRows =
    phase === "seed"
      ? config.orderCount
      : finalOrderCount(shapeFor(config), config.scenario);
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const seen = new Set<number>();
  let affectedRecords = 0;
  const { scannedRecords, pageCount } = await forEachRecordPage(
    {
      totalRows,
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
      const row = parseRowNumber(
        record.fields[fixture.orderFields.values.Title],
        "Order ",
      );
      if (seen.has(row)) throw new Error(`Duplicate Order ${row}`);
      seen.add(row);
      assertOrderFields(fixture, config, row, record.fields, phase);
      if (
        phase === "final" &&
        isAffectedOrder(shapeFor(config), config.scenario, row)
      ) {
        affectedRecords += 1;
      }
    },
  );
  return {
    scannedRecords,
    pageSize,
    pageCount,
    affectedRecords,
    unaffectedRecords: scannedRecords - affectedRecords,
  };
};

const assertPurchasesFullScan = async (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  phase: CustomerUpsertPhase,
): Promise<ScanResult> => {
  const totalRows = purchaseCount(config);
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const seen = new Set<number>();
  let affectedRecords = 0;
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
      const row = parseRowNumber(
        record.fields[fixture.purchaseFields.title],
        "Purchase ",
      );
      if (seen.has(row)) throw new Error(`Duplicate Purchase ${row}`);
      seen.add(row);
      assertPurchaseFields(fixture, config, row, record.fields, phase);
      if (
        phase === "final" &&
        isAffectedPurchase(shapeFor(config), config.scenario, row)
      ) {
        affectedRecords += 1;
      }
    },
  );
  return {
    scannedRecords,
    pageSize,
    pageCount,
    affectedRecords,
    unaffectedRecords: scannedRecords - affectedRecords,
  };
};

const waitForScan = <T>(
  config: CustomerUpsertComputedFlowCaseConfig,
  description: string,
  assertFn: () => Promise<T>,
) =>
  pollUntilReady(
    {
      timeoutMs: config.verify.timeoutMs ?? 120_000,
      pollIntervalMs: config.verify.pollIntervalMs ?? 100,
      description,
    },
    assertFn,
  );

const waitForSeedReady = async (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
): Promise<SeedReadyResult> => ({
  users: await waitForScan(config, "customer-upsert seed users", () =>
    assertUsersFullScan(fixture, config, "seed"),
  ),
  orders: await waitForScan(config, "customer-upsert seed orders", () =>
    assertOrdersFullScan(fixture, config, "seed"),
  ),
  purchases: await waitForScan(config, "customer-upsert seed purchases", () =>
    assertPurchasesFullScan(fixture, config, "seed"),
  ),
});

const responseRecordCount = (data: unknown) =>
  Array.isArray(data)
    ? data.length
    : ((data as { records?: unknown[] })?.records?.length ?? 0);

const runUserWrite = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
): Promise<Measurement<WriteEvidence>> => {
  const shape = shapeFor(config);
  if (isUserCreateScenario(config.scenario)) {
    const row = createdUserRow(shape);
    const measurement = await withPerfTraceStep(
      context,
      perfCase,
      "userWrite",
      () =>
        measureAsync("userWrite", () =>
          apiCreateRecords(fixture.usersTableId, {
            fieldKeyType: FieldKeyType.Name,
            typecast: true,
            records: [{ fields: buildUserPayload(config, row, "final") }],
          }),
        ),
    );
    if (
      measurement.result.status !== 201 ||
      responseRecordCount(measurement.result.data) !== 1
    ) {
      throw new Error(
        `User create failed: status=${measurement.result.status}, records=${responseRecordCount(measurement.result.data)}`,
      );
    }
    const recordId = measurement.result.data.records[0]?.id;
    if (!recordId) throw new Error("User create returned no record id");
    fixture.executeState.createdUserRecordId = recordId;
    const responseHeaders = pickRoutingResponseHeaders(
      measurement.result.headers as Record<string, unknown>,
    );
    return {
      name: measurement.name,
      durationMs: measurement.durationMs,
      result: {
        method: "POST",
        tableId: fixture.usersTableId,
        recordId,
        status: measurement.result.status,
        requestedRecords: 1,
        responseHeaders,
        routing: assertEngineRouting(context, responseHeaders, {
          operation: "createRecords(users)",
          feature: "createRecord",
        }),
      },
    };
  }

  const target = fixture.userRecords[config.targetUserRow - 1];
  if (!target) throw new Error(`Missing target User ${config.targetUserRow}`);
  const measurement = await withPerfTraceStep(
    context,
    perfCase,
    "userWrite",
    () =>
      measureAsync("userWrite", () =>
        apiUpdateRecords(fixture.usersTableId, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: [
            {
              id: target.recordId,
              fields: buildUserPayload(config, config.targetUserRow, "final"),
            },
          ],
        }),
      ),
  );
  if (
    measurement.result.status !== 200 ||
    responseRecordCount(measurement.result.data) !== 1
  ) {
    throw new Error(
      `User update failed: status=${measurement.result.status}, records=${responseRecordCount(measurement.result.data)}`,
    );
  }
  const responseHeaders = pickRoutingResponseHeaders(
    measurement.result.headers as Record<string, unknown>,
  );
  return {
    name: measurement.name,
    durationMs: measurement.durationMs,
    result: {
      method: "PATCH",
      tableId: fixture.usersTableId,
      recordId: target.recordId,
      status: measurement.result.status,
      requestedRecords: 1,
      responseHeaders,
      routing: assertEngineRouting(context, responseHeaders, {
        operation: "updateRecords(users)",
        feature: "updateRecords",
      }),
    },
  };
};

const runOrderWrite = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
): Promise<Measurement<WriteEvidence>> => {
  const shape = shapeFor(config);
  if (isOrderCreateScenario(config.scenario)) {
    const row = createdOrderRow(shape);
    const measurement = await withPerfTraceStep(
      context,
      perfCase,
      "orderWrite",
      () =>
        measureAsync("orderWrite", () =>
          apiCreateRecords(fixture.ordersTableId, {
            fieldKeyType: FieldKeyType.Name,
            typecast: true,
            records: [
              { fields: buildOrderPayload(fixture, config, row, "final") },
            ],
          }),
        ),
    );
    if (
      measurement.result.status !== 201 ||
      responseRecordCount(measurement.result.data) !== 1
    ) {
      throw new Error(
        `Order create failed: status=${measurement.result.status}, records=${responseRecordCount(measurement.result.data)}`,
      );
    }
    const recordId = measurement.result.data.records[0]?.id;
    if (!recordId) throw new Error("Order create returned no record id");
    fixture.executeState.createdOrderRecordId = recordId;
    const responseHeaders = pickRoutingResponseHeaders(
      measurement.result.headers as Record<string, unknown>,
    );
    return {
      name: measurement.name,
      durationMs: measurement.durationMs,
      result: {
        method: "POST",
        tableId: fixture.ordersTableId,
        recordId,
        status: measurement.result.status,
        requestedRecords: 1,
        responseHeaders,
        routing: assertEngineRouting(context, responseHeaders, {
          operation: "createRecords(orders)",
          feature: "createRecord",
        }),
      },
    };
  }

  const row = targetOrderRow(shape);
  const target = fixture.orderRecords[row - 1];
  if (!target) throw new Error(`Missing target Order ${row}`);
  const measurement = await withPerfTraceStep(
    context,
    perfCase,
    "orderWrite",
    () =>
      measureAsync("orderWrite", () =>
        apiUpdateRecords(fixture.ordersTableId, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: [
            {
              id: target.recordId,
              fields: buildOrderPayload(fixture, config, row, "final"),
            },
          ],
        }),
      ),
  );
  if (
    measurement.result.status !== 200 ||
    responseRecordCount(measurement.result.data) !== 1
  ) {
    throw new Error(
      `Order update failed: status=${measurement.result.status}, records=${responseRecordCount(measurement.result.data)}`,
    );
  }
  const responseHeaders = pickRoutingResponseHeaders(
    measurement.result.headers as Record<string, unknown>,
  );
  return {
    name: measurement.name,
    durationMs: measurement.durationMs,
    result: {
      method: "PATCH",
      tableId: fixture.ordersTableId,
      recordId: target.recordId,
      status: measurement.result.status,
      requestedRecords: 1,
      responseHeaders,
      routing: assertEngineRouting(context, responseHeaders, {
        operation: "updateRecords(orders)",
        feature: "updateRecords",
      }),
    },
  };
};

const classifyRead = (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  row: number,
  fields: Record<string, unknown>,
) => {
  const expected = buildExpectedOrderState(
    shapeFor(config),
    config.scenario,
    row,
    "final",
  );
  const cells: Array<[unknown, string]> = [
    [
      fields[fixture.orderFields.values.status],
      String(expected.orderValues.status),
    ],
    ...USER_ATTRIBUTE_NAMES.map(
      (name) =>
        [fields[fixture.orderFields.lookups[name]], expected.lookups[name]] as [
          unknown,
          string,
        ],
    ),
    ...FORMULA_NAMES.map(
      (name) =>
        [
          fields[fixture.orderFields.formulas[name]],
          expected.formulas[name],
        ] as [unknown, string],
    ),
  ];
  const matchingCells = cells.filter(
    ([actual, expectedValue]) => normalizeValue(actual) === expectedValue,
  ).length;
  const lookupValues = USER_ATTRIBUTE_NAMES.map((name) =>
    normalizeValue(fields[fixture.orderFields.lookups[name]]),
  );
  let state: FirstReadState = "mixed";
  if (matchingCells === cells.length) {
    state = "correct";
  } else if (lookupValues.every((value) => value === "")) {
    state = "null";
  } else if (row <= config.orderCount) {
    try {
      assertOrderFields(fixture, config, row, fields, "seed");
      state = "old";
    } catch {
      state = "mixed";
    }
  }
  return { state, matchingCells, totalCells: cells.length };
};

const waitForTargetOrder = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  targetRecordId: string,
  orderResponseAt: number,
  onProgress?: (evidence: TargetReadEvidence) => void,
): Promise<TargetReadEvidence> => {
  const row = isOrderCreateScenario(config.scenario)
    ? createdOrderRow(shapeFor(config))
    : targetOrderRow(shapeFor(config));
  let attempts = 0;
  let firstRead: TargetReadEvidence["firstRead"] | undefined;
  let responseHeaders: Record<string, string> = {};
  let routing: EngineRouting | undefined;
  await withPerfTraceStep(context, perfCase, "targetGetRecordsReady", () =>
    pollUntilReady(
      {
        timeoutMs: config.verify.maxPostOrderResponseMs,
        pollIntervalMs: config.verify.pollIntervalMs ?? 100,
        description: "customer target order getRecords readiness",
      },
      async () => {
        attempts += 1;
        const response = await apiGetRecords(fixture.ordersTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: orderProjection(fixture),
          filter: {
            conjunction: "and",
            filterSet: [
              {
                fieldId: fixture.orderFields.values.Title,
                operator: "is",
                value: orderTitle(row),
              },
            ],
          },
          take: 2,
        });
        if (response.status !== 200 || response.data.records.length !== 1) {
          throw new Error(
            `Target getRecords mismatch: status=${response.status}, records=${response.data.records.length}`,
          );
        }
        const record = response.data.records[0];
        if (record.id !== targetRecordId) {
          throw new Error(
            `Target getRecords returned ${record.id}, expected ${targetRecordId}`,
          );
        }
        responseHeaders = pickRoutingResponseHeaders(
          response.headers as Record<string, unknown>,
        );
        routing = assertEngineRouting(context, responseHeaders, {
          operation: "getRecords(target order)",
          feature: "getRecords",
        });
        const classification = classifyRead(
          fixture,
          config,
          row,
          record.fields,
        );
        firstRead ??= {
          ...classification,
          elapsedMs: Math.max(0, performance.now() - orderResponseAt),
        };
        onProgress?.({
          recordId: targetRecordId,
          attempts,
          firstRead,
          responseHeaders,
          routing,
        });
        if (classification.state !== "correct") {
          throw new Error(
            `Target order is ${classification.state}: matching=${classification.matchingCells}/${classification.totalCells}`,
          );
        }
        assertOrderFields(fixture, config, row, record.fields, "final");
      },
    ),
  );
  if (!firstRead || !routing) {
    throw new Error("Target order readiness completed without read evidence");
  }
  return {
    recordId: targetRecordId,
    attempts,
    firstRead,
    responseHeaders,
    routing,
  };
};

const runMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
  baseId: string,
): Promise<Measurement<PrimaryResult>> => {
  let observer: ComputedOutboxObserver | undefined;
  let outbox: ComputedOutboxObserverSummary | undefined;
  let outboxError: string | undefined;
  try {
    observer = new ComputedOutboxObserver({
      baseId,
      seedTableIds: [fixture.usersTableId, fixture.ordersTableId],
      pollIntervalMs: config.verify.outboxPollIntervalMs,
    });
    await observer.start();
  } catch (error) {
    observer = undefined;
    outboxError = error instanceof Error ? error.message : String(error);
  }

  let userWriteMeasurement: Measurement<WriteEvidence> | undefined;
  let orderWriteMeasurement: Measurement<WriteEvidence> | undefined;
  let targetRead: TargetReadEvidence | undefined;
  let postOrderResponseReadyMs = 0;
  let primaryMeasurement: Measurement<void> | undefined;
  let primaryStartedAt = performance.now();
  let orderResponseAt: number | undefined;
  let usersVerification: Measurement<ScanResult> | undefined;
  let ordersVerification: Measurement<ScanResult> | undefined;
  let purchasesVerification: Measurement<ScanResult> | undefined;
  const stopObserver = async () => {
    if (!observer) return;
    try {
      outbox = await observer.stop();
    } catch (error) {
      outboxError = error instanceof Error ? error.message : String(error);
    } finally {
      observer = undefined;
    }
  };
  const currentPrimaryResult = (): PrimaryResult => ({
    ...(userWriteMeasurement
      ? {
          userWriteMs: userWriteMeasurement.durationMs,
          userWrite: userWriteMeasurement.result,
        }
      : {}),
    ...(orderWriteMeasurement
      ? {
          orderWriteMs: orderWriteMeasurement.durationMs,
          orderWrite: orderWriteMeasurement.result,
          postOrderResponseReadyMs,
        }
      : {}),
    ...(targetRead ? { targetRead } : {}),
    ...(usersVerification
      ? {
          usersScan: usersVerification.result,
          usersVerificationMs: usersVerification.durationMs,
        }
      : {}),
    ...(ordersVerification
      ? {
          ordersScan: ordersVerification.result,
          ordersVerificationMs: ordersVerification.durationMs,
        }
      : {}),
    ...(purchasesVerification
      ? {
          purchasesScan: purchasesVerification.result,
          purchasesVerificationMs: purchasesVerification.durationMs,
        }
      : {}),
    ...(outbox ? { outbox } : {}),
    ...(outboxError ? { outboxError } : {}),
  });

  try {
    primaryMeasurement = await withPerfTraceStep(
      context,
      perfCase,
      config.threshold.metric,
      () => {
        primaryStartedAt = performance.now();
        return measureAsync(config.threshold.metric, async () => {
          userWriteMeasurement = await runUserWrite(
            perfCase,
            context,
            fixture,
            config,
          );
          orderWriteMeasurement = await runOrderWrite(
            perfCase,
            context,
            fixture,
            config,
          );
          orderResponseAt = performance.now();
          const propagationMeasurement = await measureAsync(
            "postOrderResponseReady",
            () =>
              waitForTargetOrder(
                perfCase,
                context,
                fixture,
                config,
                (orderWriteMeasurement as Measurement<WriteEvidence>).result
                  .recordId,
                orderResponseAt as number,
                (evidence) => {
                  targetRead = evidence;
                },
              ),
          );
          postOrderResponseReadyMs = propagationMeasurement.durationMs;
          targetRead = propagationMeasurement.result;
        });
      },
    );

    usersVerification = await withPerfTraceStep(
      context,
      perfCase,
      "verifyUsersFullScan",
      () =>
        measureAsync("verifyUsersFullScan", () =>
          waitForScan(config, "customer-upsert final users", () =>
            assertUsersFullScan(fixture, config, "final"),
          ),
        ),
    );
    ordersVerification = await withPerfTraceStep(
      context,
      perfCase,
      "verifyOrdersFullScan",
      () =>
        measureAsync("verifyOrdersFullScan", () =>
          waitForScan(config, "customer-upsert final orders", () =>
            assertOrdersFullScan(fixture, config, "final"),
          ),
        ),
    );
    purchasesVerification = await withPerfTraceStep(
      context,
      perfCase,
      "verifyPurchasesFullScan",
      () =>
        measureAsync("verifyPurchasesFullScan", () =>
          waitForScan(config, "customer-upsert final purchases", () =>
            assertPurchasesFullScan(fixture, config, "final"),
          ),
        ),
    );
  } catch (error) {
    const failedAt = performance.now();
    if (orderResponseAt != null && postOrderResponseReadyMs === 0) {
      postOrderResponseReadyMs = roundMetric(failedAt - orderResponseAt);
    }
    await stopObserver();
    const partialPrimaryMeasurement: Measurement<PrimaryResult> = {
      name: config.threshold.metric,
      durationMs:
        primaryMeasurement?.durationMs ??
        roundMetric(failedAt - primaryStartedAt),
      result: currentPrimaryResult(),
    };
    throw new PerfRunDiagnosticError(
      error instanceof Error ? error.message : String(error),
      {
        metrics: {},
        thresholds: [],
        details: { partialPrimaryMeasurement },
      },
    );
  }

  await stopObserver();
  if (
    !primaryMeasurement ||
    !userWriteMeasurement ||
    !orderWriteMeasurement ||
    !targetRead ||
    !usersVerification ||
    !ordersVerification ||
    !purchasesVerification
  ) {
    throw new Error("Customer flow completed without full primary evidence");
  }
  return {
    ...primaryMeasurement,
    result: currentPrimaryResult(),
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
  config: CustomerUpsertComputedFlowCaseConfig;
  fixture?: Fixture;
  prepareMeasurement?: Measurement<Fixture>;
  seedReadyMeasurement?: Measurement<SeedReadyResult>;
  primaryMeasurement?: Measurement<PrimaryResult>;
  error?: unknown;
}): PerfRunResult => {
  const primary = primaryMeasurement?.result;
  const impact = resolveImpact(shapeFor(config), config.scenario);
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
            ...(primary.userWriteMs != null
              ? { userWriteMs: primary.userWriteMs }
              : {}),
            ...(primary.orderWriteMs != null
              ? { orderWriteMs: primary.orderWriteMs }
              : {}),
            ...(primary.postOrderResponseReadyMs != null
              ? {
                  postOrderResponseReadyMs: primary.postOrderResponseReadyMs,
                  readyWithin3s:
                    primary.postOrderResponseReadyMs <= 3_000 ? 1 : 0,
                  readyWithin10s:
                    primary.postOrderResponseReadyMs <= 10_000 ? 1 : 0,
                }
              : {}),
            ...(primary.usersVerificationMs != null
              ? { usersVerificationMs: primary.usersVerificationMs }
              : {}),
            ...(primary.ordersVerificationMs != null
              ? { ordersVerificationMs: primary.ordersVerificationMs }
              : {}),
            ...(primary.purchasesVerificationMs != null
              ? { purchasesVerificationMs: primary.purchasesVerificationMs }
              : {}),
            ...(primary.targetRead
              ? { targetReadAttempts: primary.targetRead.attempts }
              : {}),
            ...(primary.outbox
              ? {
                  outboxSamples: primary.outbox.sampleCount,
                  outboxUniqueTasks: primary.outbox.uniqueTaskCount,
                  outboxObservedCompletedTasks:
                    primary.outbox.observedCompletedTaskCount,
                  outboxPeakTotal: primary.outbox.peakTotal,
                  outboxPeakPending: primary.outbox.peakPending,
                  outboxPeakProcessing: primary.outbox.peakProcessing,
                  outboxPeakDead: primary.outbox.peakDead,
                  outboxOverlapObserved: primary.outbox.overlapObserved ? 1 : 0,
                }
              : {}),
          }
        : {}),
    },
    thresholds:
      primaryMeasurement && primary
        ? [
            {
              metric: config.threshold.metric,
              max: getPrimaryThresholdMs(config.threshold.maxMs),
              unit: "ms" as const,
            },
            ...(primary.postOrderResponseReadyMs != null
              ? [
                  {
                    metric: "postOrderResponseReadyMs",
                    max: config.verify.maxPostOrderResponseMs,
                    unit: "ms" as const,
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
      ...(primary?.usersVerificationMs != null
        ? [
            {
              name: "verifyUsersFullScan",
              durationMs: primary.usersVerificationMs,
            },
          ]
        : []),
      ...(primary?.ordersVerificationMs != null
        ? [
            {
              name: "verifyOrdersFullScan",
              durationMs: primary.ordersVerificationMs,
            },
          ]
        : []),
      ...(primary?.purchasesVerificationMs != null
        ? [
            {
              name: "verifyPurchasesFullScan",
              durationMs: primary.purchasesVerificationMs,
            },
          ]
        : []),
    ],
    details: {
      operation: config.scenario,
      fixture: fixture
        ? {
            usersTableId: fixture.usersTableId,
            ordersTableId: fixture.ordersTableId,
            ordersTableName: fixture.ordersTableName,
            purchaseTableId: fixture.purchaseTableId,
            seedUserCount: config.userCount,
            seedOrderCount: config.orderCount,
            purchaseCount: purchaseCount(config),
            finalUserCount: finalUserCount(shapeFor(config), config.scenario),
            finalOrderCount: finalOrderCount(shapeFor(config), config.scenario),
            userAttributeCount: USER_ATTRIBUTE_NAMES.length,
            lookupCount: USER_ATTRIBUTE_NAMES.length,
            formulaDepth: FORMULA_NAMES.length,
            activeLink: ORDER_USER_LINK,
            guestLinkPresent: false,
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
      requests: primary
        ? {
            ...(primary.userWrite
              ? {
                  user: {
                    method: primary.userWrite.method,
                    path: `/api/table/${primary.userWrite.tableId}/record`,
                    payloadRecords: 1,
                    payloadFieldCount: USER_ATTRIBUTE_NAMES.length + 1,
                    logicallyChangedFields: isUserCreateScenario(
                      config.scenario,
                    )
                      ? USER_ATTRIBUTE_NAMES.length + 1
                      : 1,
                    logicallyChangedFieldNames: isUserCreateScenario(
                      config.scenario,
                    )
                      ? [USER_TITLE, ...USER_ATTRIBUTE_NAMES]
                      : ["first_name"],
                  },
                }
              : {}),
            ...(primary.orderWrite
              ? {
                  order: {
                    method: primary.orderWrite.method,
                    path: `/api/table/${primary.orderWrite.tableId}/record`,
                    payloadRecords: 1,
                    payloadFieldCount: ORDER_VALUE_NAMES.length + 2,
                    logicallyChangedFieldNames: isOrderCreateScenario(
                      config.scenario,
                    )
                      ? [
                          ...ORDER_VALUE_NAMES,
                          ORDER_USER_LINK,
                          ORDER_PURCHASE_LINK,
                        ]
                      : ["status"],
                    sameUserLinkResubmitted:
                      config.scenario === "update-user-update-order",
                    guestLinkSubmitted: false,
                  },
                  read: {
                    method: "GET",
                    path: `/api/table/${primary.orderWrite.tableId}/record`,
                    api: "getRecords",
                    exactTitleFilter: true,
                    take: 2,
                  },
                }
              : {}),
          }
        : undefined,
      routing: primary?.orderWrite?.routing,
      routings: primary
        ? {
            ...(primary.userWrite
              ? { userWrite: primary.userWrite.routing }
              : {}),
            ...(primary.orderWrite
              ? { orderWrite: primary.orderWrite.routing }
              : {}),
            ...(primary.targetRead
              ? { targetGetRecords: primary.targetRead.routing }
              : {}),
          }
        : undefined,
      responseHeaders: primary
        ? {
            ...(primary.userWrite
              ? { userWrite: primary.userWrite.responseHeaders }
              : {}),
            ...(primary.orderWrite
              ? { orderWrite: primary.orderWrite.responseHeaders }
              : {}),
            ...(primary.targetRead
              ? { targetGetRecords: primary.targetRead.responseHeaders }
              : {}),
          }
        : undefined,
      targetRead: primary?.targetRead,
      readiness:
        primary?.postOrderResponseReadyMs != null
          ? {
              fixedDelayMs: 0,
              pollIntervalMs: config.verify.pollIntervalMs ?? 100,
              postOrderResponseReadyMs: primary.postOrderResponseReadyMs,
              readyWithin3s: primary.postOrderResponseReadyMs <= 3_000,
              readyWithin10s: primary.postOrderResponseReadyMs <= 10_000,
            }
          : undefined,
      scans: primary
        ? {
            ...(primary.usersScan ? { users: primary.usersScan } : {}),
            ...(primary.ordersScan ? { orders: primary.ordersScan } : {}),
            ...(primary.purchasesScan
              ? { purchases: primary.purchasesScan }
              : {}),
          }
        : undefined,
      outbox:
        primary && (primary.outbox || primary.outboxError)
          ? {
              observerIsAssertion: false,
              summary: primary.outbox,
              error: primary.outboxError,
              tableLabels: fixture
                ? {
                    users: fixture.usersTableId,
                    orders: fixture.ordersTableId,
                  }
                : undefined,
            }
          : undefined,
      seedReady: seedReadyMeasurement?.result,
      error:
        error instanceof Error
          ? { name: error.name, message: error.message }
          : undefined,
    },
  };
};

const restoreUser = async (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
) => {
  const target = fixture.userRecords[config.targetUserRow - 1];
  if (!target) throw new Error(`Missing target User ${config.targetUserRow}`);
  const response = await apiUpdateRecords(fixture.usersTableId, {
    fieldKeyType: FieldKeyType.Name,
    typecast: true,
    records: [
      {
        id: target.recordId,
        fields: buildUserPayload(config, config.targetUserRow, "seed"),
      },
    ],
  });
  if (response.status !== 200 || responseRecordCount(response.data) !== 1) {
    throw new Error(`Failed to restore User ${config.targetUserRow}`);
  }
};

const restoreOrder = async (
  fixture: Fixture,
  config: CustomerUpsertComputedFlowCaseConfig,
) => {
  const row = targetOrderRow(shapeFor(config));
  const target = fixture.orderRecords[row - 1];
  if (!target) throw new Error(`Missing target Order ${row}`);
  const response = await apiUpdateRecords(fixture.ordersTableId, {
    fieldKeyType: FieldKeyType.Name,
    typecast: true,
    records: [
      {
        id: target.recordId,
        fields: buildOrderPayload(fixture, config, row, "seed"),
      },
    ],
  });
  if (response.status !== 200 || responseRecordCount(response.data) !== 1) {
    throw new Error(`Failed to restore Order ${row}`);
  }
};

const cleanupFixture = async ({
  baseId,
  fixture,
  config,
}: {
  baseId: string;
  fixture: Fixture | undefined;
  config: CustomerUpsertComputedFlowCaseConfig;
}) => {
  if (!fixture || isExecuteDbIsolated()) return;
  if (!fixture.reusableSeed) {
    await deleteFixtureTables(baseId, fixture);
    return;
  }
  try {
    if (fixture.executeState.createdOrderRecordId) {
      await deleteRecords(fixture.ordersTableId, [
        fixture.executeState.createdOrderRecordId,
      ]);
    }
    if (config.scenario === "update-user-update-order") {
      await restoreOrder(fixture, config);
    }
    if (!isUserCreateScenario(config.scenario)) {
      await restoreUser(fixture, config);
    }
    if (fixture.executeState.createdUserRecordId) {
      await deleteRecords(fixture.usersTableId, [
        fixture.executeState.createdUserRecordId,
      ]);
    }
    fixture.executeState = {};
    await waitForSeedReady(fixture, config);
  } catch (error) {
    console.warn(
      `Failed to restore customer-upsert seed ${fixture.ordersTableId}; deleting it`,
      safeErrorSummary(error),
    );
    await deleteFixtureTables(baseId, fixture);
  }
};

const lifecycleSpec: RecordMutationLifecycleSpec<
  CustomerUpsertComputedFlowCaseConfig,
  Fixture,
  SeedReadyResult,
  PrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase, context }) =>
    prepareFixture(baseId, tableName, config, perfCase, context),
  assertSeedReady: ({ fixture, config }) => waitForSeedReady(fixture, config),
  runMeasuredOperation: ({ baseId, perfCase, context, fixture, config }) =>
    runMeasuredOperation(perfCase, context, fixture, config, baseId),
  buildResult,
  cleanup: cleanupFixture,
};

export const runCustomerUpsertComputedFlowCase = async (
  perfCase: PerfCaseFor<"customer-upsert-computed-flow">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(perfCase, context, lifecycleSpec);

export const seedCustomerUpsertComputedFlowCase = async (
  perfCase: PerfCaseFor<"customer-upsert-computed-flow">,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(perfCase, context, lifecycleSpec);
