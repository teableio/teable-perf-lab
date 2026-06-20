import { FieldKeyType, FieldType, Relationship } from "@teable/core";
import { updateRecords, updateTableDescription } from "@teable/openapi";
import {
  createField,
  createRecords,
  createTable,
  getFields,
  getRecords,
  getTable,
  permanentDeleteTable,
} from "../../../utils/init-app";
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
import { withPerfTraceStep } from "../trace-collector";
import type {
  LinkComputedPropagationCaseConfig,
  PerfCase,
  PerfRunContext,
  PerfRunResult,
} from "../types";
import {
  expectedForeignTitle,
  fetchForeignIdByTitle,
  foreignRowForHostRow,
  type LinkPermutation,
} from "./link-fixture.shared";
import {
  runRecordMutationLifecycle,
  seedRecordMutationLifecycle,
  type RecordMutationLifecycleConfig,
  type RecordMutationLifecycleSpec,
} from "./record-mutation-lifecycle";

const FIXTURE_VERSION = "link-computed-propagation-v2";
const METADATA_PREFIX = "perf-lab-link-computed-propagation:";

// Customer-mirrored schema (bounded). orders host -> two many-one links (users =
// registered customer, guest), each fanning out into a full attribute set of
// lookups, then a multi-level formula chain, then a many-one into a downstream
// `purchase` table that rolls up and re-derives the orders' computed values. The
// measured write writes BOTH links for every order; the metric is the time until
// every lookup, formula, rollup, and downstream value recomputes.
const ATTRS = [
  "first_name",
  "last_name",
  "email",
  "phone",
  "address_1",
  "address_2",
  "country",
  "state",
  "postcode",
  "city",
] as const;
type Attr = (typeof ATTRS)[number];

const ORDERS_TITLE_FIELD = "Title";
const PURCHASE_TITLE_FIELD = "Title";
const FOREIGN_KEY_FIELD = "Key";
const CUSTOMER_LINK_FIELD = "customer_id_fk";
const GUEST_LINK_FIELD = "gust_email_fk";
const PURCHASE_LINK_FIELD = "purchase_fk";
const USERS_KEY_PREFIX = "user";
const GUEST_KEY_PREFIX = "guest";

// Downstream purchase rollup field names.
const P_ORDER_COUNT = "p_order_count";
const P_NAMES = "p_names";
const P_EMAILS = "p_emails";
const P_LABEL = "p_label";

const custLookupName = (attr: Attr) => `cust_${attr}`;
const guestLookupName = (attr: Attr) => `guest_${attr}`;

const userAttrValue = (attr: Attr, foreignRow: number) =>
  `u-${attr}-${String(foreignRow).padStart(6, "0")}`;
const guestAttrValue = (attr: Attr, foreignRow: number) =>
  `g-${attr}-${String(foreignRow).padStart(6, "0")}`;

const orderTitle = (rowNumber: number) => `Order ${rowNumber}`;
const purchaseTitle = (purchaseNumber: number) => `Purchase ${purchaseNumber}`;

// Multi-level formula chain. L1 over lookups, L2 over L1, L3 over L2. All use `&`
// concat (no IF/blank truthiness) and avoid ", " so downstream ARRAYJOIN rollups
// stay splittable; values still carry the row number so they are unique.
const FORMULAS: Array<{ name: string; expression: string; level: number }> = [
  {
    name: "customer_name",
    level: 1,
    expression: `{${custLookupName("first_name")}} & " " & {${custLookupName("last_name")}}`,
  },
  {
    name: "guest_name",
    level: 1,
    expression: `{${guestLookupName("first_name")}} & " " & {${guestLookupName("last_name")}}`,
  },
  {
    name: "ship_address",
    level: 1,
    expression: `{${custLookupName("address_1")}} & " " & {${custLookupName("address_2")}} & " " & {${custLookupName("city")}} & " " & {${custLookupName("state")}} & " " & {${custLookupName("postcode")}} & " " & {${custLookupName("country")}}`,
  },
  {
    name: "contact",
    level: 1,
    expression: `{${custLookupName("email")}} & " / " & {${custLookupName("phone")}} & " / " & {${guestLookupName("email")}}`,
  },
  {
    name: "summary",
    level: 2,
    expression: `{customer_name} & " | " & {guest_name} & " | " & {ship_address} & " | " & {contact}`,
  },
  {
    name: "order_card",
    level: 3,
    expression: `"ORDER " & {${ORDERS_TITLE_FIELD}} & " :: " & {summary}`,
  },
];

// Expected populated computed values for an order at `orderRowNumber` whose
// customer + guest links both resolve to foreign row `userRow`.
const expectedCustLookup = (attr: Attr, userRow: number) =>
  userAttrValue(attr, userRow);
const expectedGuestLookup = (attr: Attr, userRow: number) =>
  guestAttrValue(attr, userRow);

const expectedFormulaValue = (
  name: string,
  userRow: number,
  orderRowNumber: number,
): string => {
  const customerName = `${userAttrValue("first_name", userRow)} ${userAttrValue("last_name", userRow)}`;
  const guestName = `${guestAttrValue("first_name", userRow)} ${guestAttrValue("last_name", userRow)}`;
  const shipAddress = `${userAttrValue("address_1", userRow)} ${userAttrValue("address_2", userRow)} ${userAttrValue("city", userRow)} ${userAttrValue("state", userRow)} ${userAttrValue("postcode", userRow)} ${userAttrValue("country", userRow)}`;
  const contact = `${userAttrValue("email", userRow)} / ${userAttrValue("phone", userRow)} / ${guestAttrValue("email", userRow)}`;
  const summary = `${customerName} | ${guestName} | ${shipAddress} | ${contact}`;
  switch (name) {
    case "customer_name":
      return customerName;
    case "guest_name":
      return guestName;
    case "ship_address":
      return shipAddress;
    case "contact":
      return contact;
    case "summary":
      return summary;
    case "order_card":
      return `ORDER ${orderTitle(orderRowNumber)} :: ${summary}`;
    default:
      throw new Error(`Unknown formula ${name}`);
  }
};

type Phase = "seed" | "updated";

type NamedField = {
  id: string;
  name: string;
  type?: string;
  options?: { symmetricFieldId?: string; foreignTableId?: string };
};

type SeededRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

type OrdersFieldIds = {
  titleFieldId: string;
  customerLinkFieldId: string;
  guestLinkFieldId: string;
  purchaseLinkFieldId: string;
  custLookupIds: Record<Attr, string>;
  guestLookupIds: Record<Attr, string>;
  formulaIds: Record<string, string>;
};

type PurchaseFieldIds = {
  titleFieldId: string;
  orderCountId: string;
  namesId: string;
  emailsId: string;
  labelId: string;
};

type Fixture = {
  ordersTableId: string;
  ordersTableName: string;
  usersTableId: string;
  usersKeyFieldId: string;
  guestTableId: string;
  guestKeyFieldId: string;
  purchaseTableId: string;
  ordersFields: OrdersFieldIds;
  purchaseFields: PurchaseFieldIds;
  seededRecords: SeededRecord[];
  seedBatchDurations: number[];
  seedCacheInfo: SeedCacheInfo;
  seedCacheHit: boolean;
  reusableSeed: boolean;
};

type PrimaryResult = {
  linkWriteMs: number;
  lookupPropagationMs: number;
  requestedRecords: number;
  updatedRecords: number;
  responseHeaders: Record<string, string>;
  routing: EngineRouting;
  ordersScan: { scannedRecords: number; pageSize: number; pageCount: number };
  purchaseScan: { scannedRecords: number; pageSize: number; pageCount: number };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

// Debug-only smoke overrides so a local run can validate mechanics at small
// scale without editing the committed 10k case configs. Unset in CI.
const applySmokeOverrides = (
  config: LinkComputedPropagationCaseConfig,
): LinkComputedPropagationCaseConfig => {
  const rows = getPositiveIntegerEnv("PERF_LAB_LCP_ROWS");
  const foreignRows = getPositiveIntegerEnv("PERF_LAB_LCP_FOREIGN_ROWS");
  if (!rows && !foreignRows) {
    return config;
  }
  const rowCount = rows ?? config.rowCount;
  return {
    ...config,
    rowCount,
    foreignRowCount: foreignRows ?? config.foreignRowCount,
    verify: {
      ...config.verify,
      sampleRows: config.verify.sampleRows.filter(
        (offset) => offset < rowCount,
      ),
    },
  };
};

const purchaseRowCount = (config: LinkComputedPropagationCaseConfig) =>
  Math.ceil(config.rowCount / config.purchase.groupSize);

const purchaseForOrder = (
  orderRowNumber: number,
  config: LinkComputedPropagationCaseConfig,
) => Math.floor((orderRowNumber - 1) / config.purchase.groupSize) + 1;

const purchaseChildCount = (
  purchaseNumber: number,
  config: LinkComputedPropagationCaseConfig,
) => {
  const start = (purchaseNumber - 1) * config.purchase.groupSize + 1;
  const end = Math.min(
    purchaseNumber * config.purchase.groupSize,
    config.rowCount,
  );
  return end - start + 1;
};

const purchaseChildOrderRows = (
  purchaseNumber: number,
  config: LinkComputedPropagationCaseConfig,
) => {
  const start = (purchaseNumber - 1) * config.purchase.groupSize + 1;
  const end = Math.min(
    purchaseNumber * config.purchase.groupSize,
    config.rowCount,
  );
  const rows: number[] = [];
  for (let row = start; row <= end; row += 1) {
    rows.push(row);
  }
  return rows;
};

const permutationFor = (
  config: LinkComputedPropagationCaseConfig,
  phase: Phase,
): LinkPermutation =>
  phase === "seed"
    ? config.link.seedPermutation
    : config.link.updatePermutation;

const userRowForOrder = (
  orderRowNumber: number,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase,
) =>
  foreignRowForHostRow(
    orderRowNumber,
    config.foreignRowCount,
    permutationFor(config, phase),
  );

const parseOrderRowNumber = (value: unknown) => {
  const prefix = "Order ";
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(`Expected Title "Order <rowNumber>", got ${String(value)}`);
  }
  const rowNumber = Number(value.slice(prefix.length));
  if (!Number.isInteger(rowNumber)) {
    throw new Error(
      `Expected integer row number in Title, got ${String(value)}`,
    );
  }
  return rowNumber;
};

const parsePurchaseRowNumber = (value: unknown) => {
  const prefix = "Purchase ";
  if (typeof value !== "string" || !value.startsWith(prefix)) {
    throw new Error(
      `Expected Title "Purchase <rowNumber>", got ${String(value)}`,
    );
  }
  const rowNumber = Number(value.slice(prefix.length));
  if (!Number.isInteger(rowNumber)) {
    throw new Error(`Expected integer purchase number, got ${String(value)}`);
  }
  return rowNumber;
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

// Lookup cells over a many-one link can surface either the scalar value or a
// single-element array depending on engine/cellFormat. Normalize both, plus the
// empty shapes, so verification is shape-agnostic.
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

const getComputedSeedConfig = (config: LinkComputedPropagationCaseConfig) => ({
  baseId: config.baseId,
  mode: config.mode,
  rowCount: config.rowCount,
  batchSize: config.batchSize,
  foreignRowCount: config.foreignRowCount,
  foreignBatchSize: config.foreignBatchSize,
  purchase: config.purchase,
  link: config.link,
  attrs: [...ATTRS],
  formulas: FORMULAS,
  rollups: [P_ORDER_COUNT, P_NAMES, P_EMAILS, P_LABEL],
  verifySampleRows: config.verify.sampleRows,
  fixtureVersion: FIXTURE_VERSION,
});

type CachedSeed = {
  fixtureVersion: string;
  mode: string;
  rowCount: number;
  usersTableId: string;
  guestTableId: string;
  purchaseTableId: string;
  seededRecordIds: string[];
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
  ordersTableId: string,
  metadata: CachedSeed,
) => {
  await updateTableDescription(baseId, ordersTableId, {
    description: `${METADATA_PREFIX}${JSON.stringify(metadata)}`,
  });
};

const compileFormulaExpression = (
  expression: string,
  fieldIdByName: Map<string, string>,
) =>
  expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName.get(fieldName);
    return fieldId ? `{${fieldId}}` : match;
  });

const resolveOrdersFieldIds = (ordersFields: NamedField[]): OrdersFieldIds => {
  const custLookupIds = {} as Record<Attr, string>;
  const guestLookupIds = {} as Record<Attr, string>;
  for (const attr of ATTRS) {
    custLookupIds[attr] = resolveNamedField(
      ordersFields,
      custLookupName(attr),
    ).id;
    guestLookupIds[attr] = resolveNamedField(
      ordersFields,
      guestLookupName(attr),
    ).id;
  }
  const formulaIds: Record<string, string> = {};
  for (const formula of FORMULAS) {
    formulaIds[formula.name] = resolveNamedField(ordersFields, formula.name).id;
  }
  return {
    titleFieldId: resolveNamedField(ordersFields, ORDERS_TITLE_FIELD).id,
    customerLinkFieldId: resolveNamedField(ordersFields, CUSTOMER_LINK_FIELD)
      .id,
    guestLinkFieldId: resolveNamedField(ordersFields, GUEST_LINK_FIELD).id,
    purchaseLinkFieldId: resolveNamedField(ordersFields, PURCHASE_LINK_FIELD)
      .id,
    custLookupIds,
    guestLookupIds,
    formulaIds,
  };
};

const resolvePurchaseFieldIds = (
  purchaseFields: NamedField[],
): PurchaseFieldIds => ({
  titleFieldId: resolveNamedField(purchaseFields, PURCHASE_TITLE_FIELD).id,
  orderCountId: resolveNamedField(purchaseFields, P_ORDER_COUNT).id,
  namesId: resolveNamedField(purchaseFields, P_NAMES).id,
  emailsId: resolveNamedField(purchaseFields, P_EMAILS).id,
  labelId: resolveNamedField(purchaseFields, P_LABEL).id,
});

const seedForeignAttributeTable = async (
  baseId: string,
  tableName: string,
  attrValue: (attr: Attr, row: number) => string,
  keyPrefix: string,
  config: LinkComputedPropagationCaseConfig,
) => {
  const table = await createTable(baseId, {
    name: tableName,
    fields: [
      { name: FOREIGN_KEY_FIELD, type: FieldType.SingleLineText },
      ...ATTRS.map((attr) => ({ name: attr, type: FieldType.SingleLineText })),
    ],
    records: [],
  });
  const records = Array.from({ length: config.foreignRowCount }, (_, index) => {
    const rowNumber = index + 1;
    const fields: Record<string, string> = {
      [FOREIGN_KEY_FIELD]: expectedForeignTitle(rowNumber, keyPrefix),
    };
    for (const attr of ATTRS) {
      fields[attr] = attrValue(attr, rowNumber);
    }
    return { fields };
  });
  for (const batch of chunk(records, config.foreignBatchSize)) {
    const response = await createRecords(table.id, {
      fieldKeyType: FieldKeyType.Name,
      typecast: true,
      records: batch,
    });
    expect(response.records).toHaveLength(batch.length);
  }
  const fields = (await getFields(table.id)) as NamedField[];
  const attrFieldIds = {} as Record<Attr, string>;
  for (const attr of ATTRS) {
    attrFieldIds[attr] = resolveNamedField(fields, attr).id;
  }
  return {
    tableId: table.id,
    keyFieldId: resolveNamedField(fields, FOREIGN_KEY_FIELD).id,
    attrFieldIds,
  };
};

const createOrdersComputedFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  ordersTableId: string,
  usersTableId: string,
  guestTableId: string,
  links: { customerLinkFieldId: string; guestLinkFieldId: string },
  foreignFieldIds: {
    users: Record<Attr, string>;
    guest: Record<Attr, string>;
  },
) => {
  for (const attr of ATTRS) {
    await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createLookup:${custLookupName(attr)}`,
      () =>
        createField(ordersTableId, {
          name: custLookupName(attr),
          type: FieldType.SingleLineText,
          isLookup: true,
          lookupOptions: {
            foreignTableId: usersTableId,
            linkFieldId: links.customerLinkFieldId,
            lookupFieldId: foreignFieldIds.users[attr],
          },
        }),
    );
    await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createLookup:${guestLookupName(attr)}`,
      () =>
        createField(ordersTableId, {
          name: guestLookupName(attr),
          type: FieldType.SingleLineText,
          isLookup: true,
          lookupOptions: {
            foreignTableId: guestTableId,
            linkFieldId: links.guestLinkFieldId,
            lookupFieldId: foreignFieldIds.guest[attr],
          },
        }),
    );
  }

  // Create formulas in dependency-level order so each level's {name} refs resolve
  // to already-created field ids.
  const ordersFields = (await getFields(ordersTableId)) as NamedField[];
  const fieldIdByName = new Map(ordersFields.map((f) => [f.name, f.id]));
  const orderedFormulas = [...FORMULAS].sort((a, b) => a.level - b.level);
  for (const formula of orderedFormulas) {
    const created = await withPerfTraceStep(
      context,
      perfCase,
      `seedBuild:createFormula:${formula.name}`,
      () =>
        createField(ordersTableId, {
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
    fieldIdByName.set(formula.name, created.id);
  }
};

const createPurchaseComputedFields = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  purchaseTableId: string,
  ordersTableId: string,
  ordersLinkFieldOnPurchaseId: string,
  ordersFieldIds: {
    titleFieldId: string;
    customerNameId: string;
    custEmailId: string;
  },
) => {
  const rollup = (name: string, expression: string, lookupFieldId: string) =>
    withPerfTraceStep(context, perfCase, `seedBuild:createRollup:${name}`, () =>
      createField(purchaseTableId, {
        name,
        type: FieldType.Rollup,
        options: { expression },
        lookupOptions: {
          foreignTableId: ordersTableId,
          linkFieldId: ordersLinkFieldOnPurchaseId,
          lookupFieldId,
        },
      }),
    );
  await rollup(
    P_ORDER_COUNT,
    "countall({values})",
    ordersFieldIds.titleFieldId,
  );
  await rollup(P_NAMES, "array_join({values})", ordersFieldIds.customerNameId);
  await rollup(P_EMAILS, "array_join({values})", ordersFieldIds.custEmailId);

  const purchaseFields = (await getFields(purchaseTableId)) as NamedField[];
  const fieldIdByName = new Map(purchaseFields.map((f) => [f.name, f.id]));
  await withPerfTraceStep(
    context,
    perfCase,
    `seedBuild:createFormula:${P_LABEL}`,
    () =>
      createField(purchaseTableId, {
        name: P_LABEL,
        type: FieldType.Formula,
        options: {
          expression: compileFormulaExpression(
            `"PURCHASE " & {${PURCHASE_TITLE_FIELD}} & " count=" & {${P_ORDER_COUNT}}`,
            fieldIdByName,
          ),
        },
      }),
  );
};

const buildOrderLinkUpdates = (
  fixture: Fixture,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase | "clear",
  userIdByTitle: Map<string, string>,
  guestIdByTitle: Map<string, string>,
) =>
  fixture.seededRecords.map((record) => {
    if (phase === "clear") {
      return {
        id: record.recordId,
        fields: {
          [fixture.ordersFields.customerLinkFieldId]: null,
          [fixture.ordersFields.guestLinkFieldId]: null,
        },
      };
    }
    const userRow = userRowForOrder(record.rowNumber, config, phase);
    const userId = userIdByTitle.get(
      expectedForeignTitle(userRow, USERS_KEY_PREFIX),
    );
    const guestId = guestIdByTitle.get(
      expectedForeignTitle(userRow, GUEST_KEY_PREFIX),
    );
    if (!userId || !guestId) {
      throw new Error(
        `No foreign id for order row ${record.rowNumber} (userRow ${userRow})`,
      );
    }
    return {
      id: record.recordId,
      fields: {
        [fixture.ordersFields.customerLinkFieldId]: { id: userId },
        [fixture.ordersFields.guestLinkFieldId]: { id: guestId },
      },
    };
  });

const writeOrderLinks = async (
  fixture: Fixture,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase | "clear",
  userIdByTitle: Map<string, string>,
  guestIdByTitle: Map<string, string>,
) => {
  const updates = buildOrderLinkUpdates(
    fixture,
    config,
    phase,
    userIdByTitle,
    guestIdByTitle,
  );
  let requested = 0;
  let updated = 0;
  let responseHeaders: Record<string, string> = {};
  for (const batch of chunk(updates, config.writeBatchSize)) {
    const response = await updateRecords(fixture.ordersTableId, {
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

const assertOrderComputed = (
  fields: Record<string, unknown>,
  orderRowNumber: number,
  userRow: number,
  fixture: Fixture,
  linked: boolean,
) => {
  for (const attr of ATTRS) {
    const custActual = normalizeLookupValue(
      fields[fixture.ordersFields.custLookupIds[attr]],
    );
    const custExpected = linked ? expectedCustLookup(attr, userRow) : null;
    if (custActual !== custExpected) {
      throw new Error(
        `Order ${orderRowNumber} cust_${attr} mismatch: expected ${String(custExpected)}, actual ${String(custActual)}`,
      );
    }
    const guestActual = normalizeLookupValue(
      fields[fixture.ordersFields.guestLookupIds[attr]],
    );
    const guestExpected = linked ? expectedGuestLookup(attr, userRow) : null;
    if (guestActual !== guestExpected) {
      throw new Error(
        `Order ${orderRowNumber} guest_${attr} mismatch: expected ${String(guestExpected)}, actual ${String(guestActual)}`,
      );
    }
  }
  if (!linked) {
    return;
  }
  for (const formula of FORMULAS) {
    const actual = fields[fixture.ordersFields.formulaIds[formula.name]];
    const expected = expectedFormulaValue(
      formula.name,
      userRow,
      orderRowNumber,
    );
    if (actual !== expected) {
      throw new Error(
        `Order ${orderRowNumber} formula ${formula.name} mismatch: expected ${expected}, actual ${String(actual)}`,
      );
    }
  }
};

const ordersProjection = (fixture: Fixture) => [
  fixture.ordersFields.titleFieldId,
  ...ATTRS.map((attr) => fixture.ordersFields.custLookupIds[attr]),
  ...ATTRS.map((attr) => fixture.ordersFields.guestLookupIds[attr]),
  ...FORMULAS.map((formula) => fixture.ordersFields.formulaIds[formula.name]),
];

const assertOrdersFullScan = async (
  fixture: Fixture,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase,
  linked: boolean,
) => {
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const projection = ordersProjection(fixture);
  const seen = new Set<number>();
  let scannedRecords = 0;
  let pageCount = 0;
  for (let skip = 0; skip < config.rowCount; skip += pageSize) {
    const expectedTake = Math.min(pageSize, config.rowCount - skip);
    const result = await getRecords(fixture.ordersTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection,
      skip,
      take: expectedTake,
    });
    pageCount += 1;
    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} orders at skip ${skip}, got ${result.records.length}`,
      );
    }
    for (const record of result.records) {
      const orderRowNumber = parseOrderRowNumber(
        record.fields[fixture.ordersFields.titleFieldId],
      );
      if (seen.has(orderRowNumber)) {
        throw new Error(`Duplicate order row in scan: ${orderRowNumber}`);
      }
      seen.add(orderRowNumber);
      const userRow = userRowForOrder(orderRowNumber, config, phase);
      assertOrderComputed(
        record.fields,
        orderRowNumber,
        userRow,
        fixture,
        linked,
      );
      scannedRecords += 1;
    }
  }
  if (scannedRecords !== config.rowCount) {
    throw new Error(
      `Orders scan count mismatch: expected ${config.rowCount}, scanned ${scannedRecords}`,
    );
  }
  return { scannedRecords, pageSize, pageCount };
};

// Verify the downstream purchase rollups + formula. Rollup ARRAYJOIN order is not
// asserted; instead each child's computed value must appear in the joined string
// and the COUNTALL must equal the child count (robust to separator/order).
const assertPurchaseFullScan = async (
  fixture: Fixture,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase,
) => {
  const total = purchaseRowCount(config);
  const pageSize = config.verify.fullScanPageSize ?? 1_000;
  const projection = [
    fixture.purchaseFields.titleFieldId,
    fixture.purchaseFields.orderCountId,
    fixture.purchaseFields.namesId,
    fixture.purchaseFields.emailsId,
    fixture.purchaseFields.labelId,
  ];
  const seen = new Set<number>();
  let scannedRecords = 0;
  let pageCount = 0;
  for (let skip = 0; skip < total; skip += pageSize) {
    const expectedTake = Math.min(pageSize, total - skip);
    const result = await getRecords(fixture.purchaseTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection,
      skip,
      take: expectedTake,
    });
    pageCount += 1;
    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} purchases at skip ${skip}, got ${result.records.length}`,
      );
    }
    for (const record of result.records) {
      const purchaseNumber = parsePurchaseRowNumber(
        record.fields[fixture.purchaseFields.titleFieldId],
      );
      if (seen.has(purchaseNumber)) {
        throw new Error(`Duplicate purchase row in scan: ${purchaseNumber}`);
      }
      seen.add(purchaseNumber);
      const childCount = purchaseChildCount(purchaseNumber, config);
      const actualCount = Number(
        record.fields[fixture.purchaseFields.orderCountId],
      );
      if (actualCount !== childCount) {
        throw new Error(
          `Purchase ${purchaseNumber} order count mismatch: expected ${childCount}, actual ${String(actualCount)}`,
        );
      }
      const names = String(record.fields[fixture.purchaseFields.namesId] ?? "");
      const emails = String(
        record.fields[fixture.purchaseFields.emailsId] ?? "",
      );
      for (const childRow of purchaseChildOrderRows(purchaseNumber, config)) {
        const userRow = userRowForOrder(childRow, config, phase);
        const childName = expectedFormulaValue(
          "customer_name",
          userRow,
          childRow,
        );
        if (!names.includes(childName)) {
          throw new Error(
            `Purchase ${purchaseNumber} p_names missing child ${childRow} name "${childName}"; actual="${names}"`,
          );
        }
        const childEmail = expectedCustLookup("email", userRow);
        if (!emails.includes(childEmail)) {
          throw new Error(
            `Purchase ${purchaseNumber} p_emails missing child ${childRow} email "${childEmail}"`,
          );
        }
      }
      const label = record.fields[fixture.purchaseFields.labelId];
      const expectedLabel = `PURCHASE ${purchaseTitle(purchaseNumber)} count=${childCount}`;
      if (label !== expectedLabel) {
        throw new Error(
          `Purchase ${purchaseNumber} p_label mismatch: expected ${expectedLabel}, actual ${String(label)}`,
        );
      }
      scannedRecords += 1;
    }
  }
  if (scannedRecords !== total) {
    throw new Error(
      `Purchase scan count mismatch: expected ${total}, scanned ${scannedRecords}`,
    );
  }
  return { scannedRecords, pageSize, pageCount };
};

const waitForReadyFullScan = async (
  fixture: Fixture,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase,
  context: PerfRunContext,
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 300_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 250;
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    if (context.signal?.aborted) {
      throw new Error("aborted while waiting for computed propagation");
    }
    try {
      const ordersScan = await assertOrdersFullScan(
        fixture,
        config,
        phase,
        true,
      );
      const purchaseScan = await assertPurchaseFullScan(fixture, config, phase);
      return { ordersScan, purchaseScan };
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(
    `Timed out waiting for computed propagation after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

// seedReady is cheap: only checks orders sample rows (not the downstream
// purchase, which is proven in the post-write full readiness scan).
const assertOrderSamples = async (
  fixture: Fixture,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase,
  linked: boolean,
) => {
  const projection = ordersProjection(fixture);
  let checkedRecords = 0;
  for (const rowOffset of config.verify.sampleRows) {
    const seededRecord = fixture.seededRecords[rowOffset];
    if (!seededRecord) {
      throw new Error(
        `Missing seeded order metadata at row offset ${rowOffset}`,
      );
    }
    const result = await getRecords(fixture.ordersTableId, {
      fieldKeyType: FieldKeyType.Id,
      projection,
      skip: rowOffset,
      take: 1,
    });
    const record = result.records[0];
    if (!record) {
      throw new Error(`Missing order sample at row offset ${rowOffset}`);
    }
    const orderRowNumber = parseOrderRowNumber(
      record.fields[fixture.ordersFields.titleFieldId],
    );
    const userRow = userRowForOrder(orderRowNumber, config, phase);
    assertOrderComputed(
      record.fields,
      orderRowNumber,
      userRow,
      fixture,
      linked,
    );
    checkedRecords += 1;
  }
  return { checkedRecords };
};

const waitForOrderSamples = async (
  fixture: Fixture,
  config: LinkComputedPropagationCaseConfig,
  phase: Phase,
  linked: boolean,
) => {
  const startedAt = Date.now();
  const timeoutMs = config.verify.timeoutMs ?? 300_000;
  const pollIntervalMs = config.verify.pollIntervalMs ?? 250;
  let lastError: unknown;
  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertOrderSamples(fixture, config, phase, linked);
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(
    `Timed out waiting for seed order samples after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};

const seededOrdersAreLinked = (config: LinkComputedPropagationCaseConfig) =>
  config.mode === "repoint";

const restoreFixture = async (
  baseId: string,
  config: LinkComputedPropagationCaseConfig,
  seedCacheInfo: SeedCacheInfo,
): Promise<Fixture | undefined> => {
  if (!seedCacheInfo.enabled) {
    return;
  }
  const ordersTableName = seedCacheInfo.seedTableName;
  const cachedOrders = await findSeedTable(baseId, ordersTableName);
  if (!cachedOrders) {
    return;
  }
  try {
    const ordersFieldVos = (await getFields(cachedOrders.id)) as NamedField[];
    const ordersFields = resolveOrdersFieldIds(ordersFieldVos);
    const tableMeta = await getTable(baseId, cachedOrders.id);
    const cachedSeed = parseCachedSeed(tableMeta.description);
    if (
      !cachedSeed ||
      cachedSeed.fixtureVersion !== FIXTURE_VERSION ||
      cachedSeed.mode !== config.mode ||
      cachedSeed.rowCount !== config.rowCount ||
      cachedSeed.seededRecordIds.length !== config.rowCount
    ) {
      throw new Error(
        `Missing or stale cached seed metadata for ${ordersTableName}`,
      );
    }
    const usersFields = (await getFields(
      cachedSeed.usersTableId,
    )) as NamedField[];
    const guestFields = (await getFields(
      cachedSeed.guestTableId,
    )) as NamedField[];
    const purchaseFieldVos = (await getFields(
      cachedSeed.purchaseTableId,
    )) as NamedField[];
    const fixture: Fixture = {
      ordersTableId: cachedOrders.id,
      ordersTableName: cachedOrders.name,
      usersTableId: cachedSeed.usersTableId,
      usersKeyFieldId: resolveNamedField(usersFields, FOREIGN_KEY_FIELD).id,
      guestTableId: cachedSeed.guestTableId,
      guestKeyFieldId: resolveNamedField(guestFields, FOREIGN_KEY_FIELD).id,
      purchaseTableId: cachedSeed.purchaseTableId,
      ordersFields,
      purchaseFields: resolvePurchaseFieldIds(purchaseFieldVos),
      seededRecords: cachedSeed.seededRecordIds.map((recordId, index) => ({
        rowOffset: index,
        rowNumber: index + 1,
        recordId,
      })),
      seedBatchDurations: [0],
      seedCacheInfo,
      seedCacheHit: true,
      reusableSeed: true,
    };
    await waitForOrderSamples(
      fixture,
      config,
      "seed",
      seededOrdersAreLinked(config),
    );
    return fixture;
  } catch (error) {
    console.warn(
      `Invalid cached link-computed seed ${ordersTableName}; rebuilding`,
      error,
    );
    const cachedSeed = parseCachedSeed(
      (await getTable(baseId, cachedOrders.id).catch(() => null))?.description,
    );
    for (const tableId of [
      cachedOrders.id,
      cachedSeed?.usersTableId,
      cachedSeed?.guestTableId,
      cachedSeed?.purchaseTableId,
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
  config: LinkComputedPropagationCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
  seedCacheInfo: SeedCacheInfo,
  fallbackTableName: string,
): Promise<Fixture> => {
  const ordersTableName = seedCacheInfo.enabled
    ? seedCacheInfo.seedTableName
    : fallbackTableName;
  const usersTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "users")
    : `${fallbackTableName}-users`;
  const guestTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "guest")
    : `${fallbackTableName}-guest`;
  const purchaseTableName = seedCacheInfo.enabled
    ? buildSeedTableName(seedCacheInfo, "purchase")
    : `${fallbackTableName}-purchase`;

  const createdTableIds: string[] = [];
  try {
    const users = await seedForeignAttributeTable(
      baseId,
      usersTableName,
      userAttrValue,
      USERS_KEY_PREFIX,
      config,
    );
    createdTableIds.push(users.tableId);
    const guest = await seedForeignAttributeTable(
      baseId,
      guestTableName,
      guestAttrValue,
      GUEST_KEY_PREFIX,
      config,
    );
    createdTableIds.push(guest.tableId);

    // Downstream purchase table (Title only for now; rollups added after orders).
    const purchase = await createTable(baseId, {
      name: purchaseTableName,
      fields: [{ name: PURCHASE_TITLE_FIELD, type: FieldType.SingleLineText }],
      records: [],
    });
    createdTableIds.push(purchase.id);
    const totalPurchases = purchaseRowCount(config);
    const purchaseRecords = Array.from(
      { length: totalPurchases },
      (_, index) => ({
        fields: { [PURCHASE_TITLE_FIELD]: purchaseTitle(index + 1) },
      }),
    );
    for (const batch of chunk(purchaseRecords, config.foreignBatchSize)) {
      const response = await createRecords(purchase.id, {
        fieldKeyType: FieldKeyType.Name,
        records: batch,
      });
      expect(response.records).toHaveLength(batch.length);
    }
    const purchaseFieldsInitial = (await getFields(
      purchase.id,
    )) as NamedField[];
    const purchaseTitleFieldId = resolveNamedField(
      purchaseFieldsInitial,
      PURCHASE_TITLE_FIELD,
    ).id;
    const purchaseIdByTitle = await fetchForeignIdByTitle(
      purchase.id,
      purchaseTitleFieldId,
      totalPurchases,
    );

    // Orders table: Title + two foreign links (one-way) + purchase link (two-way
    // so purchase can roll up over its orders).
    const orders = await createTable(baseId, {
      name: ordersTableName,
      fields: [
        { name: ORDERS_TITLE_FIELD, type: FieldType.SingleLineText },
        {
          name: CUSTOMER_LINK_FIELD,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId: users.tableId,
            isOneWay: config.link.isOneWay,
          },
        },
        {
          name: GUEST_LINK_FIELD,
          type: FieldType.Link,
          options: {
            relationship: Relationship.ManyOne,
            foreignTableId: guest.tableId,
            isOneWay: config.link.isOneWay,
          },
        },
        {
          name: PURCHASE_LINK_FIELD,
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

    const ordersBaseFields = (await getFields(orders.id)) as NamedField[];
    const customerLinkFieldId = resolveNamedField(
      ordersBaseFields,
      CUSTOMER_LINK_FIELD,
    ).id;
    const guestLinkFieldId = resolveNamedField(
      ordersBaseFields,
      GUEST_LINK_FIELD,
    ).id;
    const purchaseLinkField = resolveNamedField(
      ordersBaseFields,
      PURCHASE_LINK_FIELD,
    );
    const ordersLinkFieldOnPurchaseId =
      purchaseLinkField.options?.symmetricFieldId;
    if (!ordersLinkFieldOnPurchaseId) {
      throw new Error(
        "purchase_fk link is missing a symmetric field id for rollups",
      );
    }

    await createOrdersComputedFields(
      perfCase,
      context,
      orders.id,
      users.tableId,
      guest.tableId,
      { customerLinkFieldId, guestLinkFieldId },
      { users: users.attrFieldIds, guest: guest.attrFieldIds },
    );
    const ordersFieldVos = (await getFields(orders.id)) as NamedField[];
    const ordersFields = resolveOrdersFieldIds(ordersFieldVos);

    await createPurchaseComputedFields(
      perfCase,
      context,
      purchase.id,
      orders.id,
      ordersLinkFieldOnPurchaseId,
      {
        titleFieldId: ordersFields.titleFieldId,
        customerNameId: ordersFields.formulaIds.customer_name,
        custEmailId: ordersFields.custLookupIds.email,
      },
    );
    const purchaseFieldVos = (await getFields(purchase.id)) as NamedField[];
    const purchaseFields = resolvePurchaseFieldIds(purchaseFieldVos);

    const userIdByTitle = seededOrdersAreLinked(config)
      ? await fetchForeignIdByTitle(
          users.tableId,
          users.keyFieldId,
          config.foreignRowCount,
        )
      : new Map<string, string>();
    const guestIdByTitle = seededOrdersAreLinked(config)
      ? await fetchForeignIdByTitle(
          guest.tableId,
          guest.keyFieldId,
          config.foreignRowCount,
        )
      : new Map<string, string>();

    const records = Array.from({ length: config.rowCount }, (_, index) => {
      const rowNumber = index + 1;
      const purchaseId = purchaseIdByTitle.get(
        purchaseTitle(purchaseForOrder(rowNumber, config)),
      );
      if (!purchaseId) {
        throw new Error(`No purchase id for order row ${rowNumber}`);
      }
      const orderFields: Record<string, unknown> = {
        [ORDERS_TITLE_FIELD]: orderTitle(rowNumber),
        [PURCHASE_LINK_FIELD]: { id: purchaseId },
      };
      if (seededOrdersAreLinked(config)) {
        const userRow = userRowForOrder(rowNumber, config, "seed");
        const userId = userIdByTitle.get(
          expectedForeignTitle(userRow, USERS_KEY_PREFIX),
        );
        const guestId = guestIdByTitle.get(
          expectedForeignTitle(userRow, GUEST_KEY_PREFIX),
        );
        if (!userId || !guestId) {
          throw new Error(`No foreign id for seed order row ${rowNumber}`);
        }
        orderFields[CUSTOMER_LINK_FIELD] = { id: userId };
        orderFields[GUEST_LINK_FIELD] = { id: guestId };
      }
      return { rowOffset: index, rowNumber, record: { fields: orderFields } };
    });

    const seededRecords: SeededRecord[] = [];
    const seedBatchDurations: number[] = [];
    for (const batch of chunk(records, config.batchSize)) {
      const batchMeasurement = await measureAsync("seedBatch", () =>
        createRecords(orders.id, {
          fieldKeyType: FieldKeyType.Name,
          typecast: true,
          records: batch.map((item) => item.record),
        }),
      );
      seedBatchDurations.push(batchMeasurement.durationMs);
      expect(batchMeasurement.result.records).toHaveLength(batch.length);
      batchMeasurement.result.records.forEach((record, index) => {
        const input = batch[index];
        if (input) {
          seededRecords.push({
            rowOffset: input.rowOffset,
            rowNumber: input.rowNumber,
            recordId: record.id,
          });
        }
      });
    }

    await persistCachedSeed(baseId, orders.id, {
      fixtureVersion: FIXTURE_VERSION,
      mode: config.mode,
      rowCount: config.rowCount,
      usersTableId: users.tableId,
      guestTableId: guest.tableId,
      purchaseTableId: purchase.id,
      seededRecordIds: seededRecords.map((record) => record.recordId),
    });

    return {
      ordersTableId: orders.id,
      ordersTableName,
      usersTableId: users.tableId,
      usersKeyFieldId: users.keyFieldId,
      guestTableId: guest.tableId,
      guestKeyFieldId: guest.keyFieldId,
      purchaseTableId: purchase.id,
      ordersFields,
      purchaseFields,
      seededRecords,
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

const buildFixture = async (
  baseId: string,
  config: LinkComputedPropagationCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
  seedCacheInfo: SeedCacheInfo,
  fallbackTableName: string,
) =>
  (await restoreFixture(baseId, config, seedCacheInfo)) ??
  createFixture(
    baseId,
    config,
    perfCase,
    context,
    seedCacheInfo,
    fallbackTableName,
  );

const buildResult = ({
  config,
  fixture,
  prepareMeasurement,
  seedReadyMeasurement,
  totalMeasurement,
  primary,
  error,
}: {
  config: LinkComputedPropagationCaseConfig;
  fixture?: Fixture;
  prepareMeasurement?: Measurement<Fixture>;
  seedReadyMeasurement?: Measurement<{ checkedRecords: number }>;
  totalMeasurement?: Measurement<unknown>;
  primary?: PrimaryResult;
  error?: unknown;
}): PerfRunResult => ({
  metrics: {
    ...(prepareMeasurement ? { prepareMs: prepareMeasurement.durationMs } : {}),
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
    ...(totalMeasurement && primary
      ? {
          lookupReadyTotalMs: totalMeasurement.durationMs,
          linkWriteMs: primary.linkWriteMs,
          lookupPropagationMs: primary.lookupPropagationMs,
        }
      : {}),
  },
  thresholds:
    totalMeasurement && primary
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
    ...(totalMeasurement
      ? [
          {
            name: totalMeasurement.name,
            durationMs: totalMeasurement.durationMs,
          },
        ]
      : []),
  ],
  details: {
    operation: "write-both-links-then-await-computed-cascade",
    mode: config.mode,
    ordersTableId: fixture?.ordersTableId,
    ordersTableName: fixture?.ordersTableName,
    usersTableId: fixture?.usersTableId,
    guestTableId: fixture?.guestTableId,
    purchaseTableId: fixture?.purchaseTableId,
    rowCount: config.rowCount,
    foreignRowCount: config.foreignRowCount,
    purchaseRowCount: purchaseRowCount(config),
    purchaseGroupSize: config.purchase.groupSize,
    batchSize: config.batchSize,
    computedFields: fixture
      ? {
          custLookups: ATTRS.map((attr) => custLookupName(attr)),
          guestLookups: ATTRS.map((attr) => guestLookupName(attr)),
          formulas: FORMULAS.map((formula) => formula.name),
          purchaseRollups: [P_ORDER_COUNT, P_NAMES, P_EMAILS],
          purchaseFormulas: [P_LABEL],
        }
      : undefined,
    request: fixture
      ? {
          method: "PATCH",
          path: `/api/table/${fixture.ordersTableId}/record`,
          fieldKeyType: "id",
          typecast: false,
          recordCount: fixture.seededRecords.length,
          customerLinkFieldId: fixture.ordersFields.customerLinkFieldId,
          guestLinkFieldId: fixture.ordersFields.guestLinkFieldId,
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
    ordersScan: primary?.ordersScan,
    purchaseScan: primary?.purchaseScan,
    seed: fixture
      ? {
          seededRecords: fixture.seededRecords.length,
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
});

// link-computed-propagation rides the record-mutation lifecycle: seed (or
// restore) the orders host + users/guest foreign + downstream purchase fixture,
// run one measured "write both order links then await the full computed cascade"
// operation, then restore-or-delete the reusable seed. It is the family's most
// fan-out fixture (four tables) and its measured primary bundles the link write
// and the propagation full-scan wait into a single window, but the driver treats
// the fixture opaquely and owns no extra protocol, so it rides byte-unchanged.
//
// Two boundary adaptations keep the driver generic (see toLifecyclePerfCase):
// this case config names its prefix `ordersTableNamePrefix` (it owns four
// tables), so the entry points alias it to the driver's `tableNamePrefix` before
// delegating — the driver then derives the exact same
// `${prefix}-[seed-]${Date.now()}` fallback name the legacy runner used. Smoke
// overrides are applied once at that boundary so every spec callback (and the
// seed-cache hash) sees the overridden config.
type LcpLifecycleConfig = LinkComputedPropagationCaseConfig &
  RecordMutationLifecycleConfig;

const prepareLcpFixture = async (
  baseId: string,
  fallbackTableName: string,
  config: LinkComputedPropagationCaseConfig,
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<Fixture> => {
  const seedCacheInfo = await buildSeedCacheInfo({
    perfCase,
    runner: "link-computed-propagation",
    fixtureVersion: FIXTURE_VERSION,
    seedConfig: getComputedSeedConfig(config) as never,
    seedCodeFiles: [
      new URL(import.meta.url),
      new URL("../seed-cache.ts", import.meta.url),
      new URL("./link-fixture.shared.ts", import.meta.url),
    ],
  });
  return buildFixture(
    baseId,
    config,
    perfCase,
    context,
    seedCacheInfo,
    fallbackTableName,
  );
};

// The single measured operation: resolve foreign ids (unmeasured setup) ->
// trace-wrapped write of BOTH order links -> propagation wait (full orders +
// purchase recompute scan) -> routing assertion, bundled into one primary
// measurement whose duration is lookupReadyTotalMs. The inner linkWrite trace
// step is preserved so the write keeps its own trace ref. No record window, so
// the driver invokes this directly.
const runLcpMeasuredOperation = async (
  perfCase: PerfCase,
  context: PerfRunContext,
  config: LinkComputedPropagationCaseConfig,
  fixture: Fixture,
): Promise<Measurement<PrimaryResult>> => {
  // Execute setup (not measured): resolve foreign titles -> record ids.
  const [userIdByTitle, guestIdByTitle] = await Promise.all([
    fetchForeignIdByTitle(
      fixture.usersTableId,
      fixture.usersKeyFieldId,
      config.foreignRowCount,
    ),
    fetchForeignIdByTitle(
      fixture.guestTableId,
      fixture.guestKeyFieldId,
      config.foreignRowCount,
    ),
  ]);

  let linkWriteMs = 0;
  let lookupPropagationMs = 0;
  let responseHeaders: Record<string, string> = {};
  let requestedRecords = 0;
  let updatedRecords = 0;
  let ordersScan = { scannedRecords: 0, pageSize: 0, pageCount: 0 };
  let purchaseScan = { scannedRecords: 0, pageSize: 0, pageCount: 0 };

  const totalMeasurement = await withPerfTraceStep(
    context,
    perfCase,
    config.threshold.metric,
    () =>
      measureAsync(config.threshold.metric, async () => {
        const writeMeasurement = await withPerfTraceStep(
          context,
          perfCase,
          "linkWrite",
          () =>
            measureAsync("linkWrite", () =>
              writeOrderLinks(
                fixture,
                config,
                "updated",
                userIdByTitle,
                guestIdByTitle,
              ),
            ),
        );
        linkWriteMs = writeMeasurement.durationMs;
        responseHeaders = writeMeasurement.result.responseHeaders;
        requestedRecords = writeMeasurement.result.requestedRecords;
        updatedRecords = writeMeasurement.result.updatedRecords;

        const propagationMeasurement = await measureAsync(
          "lookupPropagation",
          () => waitForReadyFullScan(fixture, config, "updated", context),
        );
        lookupPropagationMs = propagationMeasurement.durationMs;
        ordersScan = propagationMeasurement.result.ordersScan;
        purchaseScan = propagationMeasurement.result.purchaseScan;
      }),
  );

  const routing = assertEngineRouting(context, responseHeaders, {
    operation: "updateRecords",
  });
  return {
    ...totalMeasurement,
    result: {
      linkWriteMs,
      lookupPropagationMs,
      requestedRecords,
      updatedRecords,
      responseHeaders,
      routing,
      ordersScan,
      purchaseScan,
    },
  };
};

// Class C cleanup: the measured write re-points the reusable seed's order links,
// so a shared (non-isolated) execute DB must be restored to the seed state — or
// all four fixture tables dropped if restore fails — before the next run reuses
// it. Foreign id maps are re-resolved here (cleanup is unmeasured) instead of
// being threaded from the measured op, matching record-update-link. Isolated CI
// execute DBs are discarded by teardown, so cleanup is skipped.
const cleanupLcpFixture = async ({
  baseId,
  fixture,
  config,
}: {
  baseId: string;
  fixture: Fixture | undefined;
  config: LinkComputedPropagationCaseConfig;
}) => {
  if (!fixture || isExecuteDbIsolated()) {
    return;
  }
  const seededLinked = seededOrdersAreLinked(config);
  const dropAllTables = async () => {
    for (const tableId of [
      fixture.ordersTableId,
      fixture.usersTableId,
      fixture.guestTableId,
      fixture.purchaseTableId,
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
    const [userIdByTitle, guestIdByTitle] = await Promise.all([
      fetchForeignIdByTitle(
        fixture.usersTableId,
        fixture.usersKeyFieldId,
        config.foreignRowCount,
      ),
      fetchForeignIdByTitle(
        fixture.guestTableId,
        fixture.guestKeyFieldId,
        config.foreignRowCount,
      ),
    ]);
    await writeOrderLinks(
      fixture,
      config,
      seededLinked ? "seed" : "clear",
      userIdByTitle,
      guestIdByTitle,
    );
    await waitForOrderSamples(fixture, config, "seed", seededLinked);
    restored = true;
  } catch (error) {
    console.warn(
      `Failed to restore cached link-computed seed ${fixture.ordersTableId}; deleting it`,
      error,
    );
  }
  if (!restored) {
    await dropAllTables();
  }
};

const linkComputedPropagationLifecycleSpec: RecordMutationLifecycleSpec<
  LcpLifecycleConfig,
  Fixture,
  { checkedRecords: number },
  PrimaryResult
> = {
  prepareFixture: ({ baseId, tableName, config, perfCase, context }) =>
    prepareLcpFixture(baseId, tableName, config, perfCase, context),
  assertSeedReady: ({ fixture, config }) =>
    waitForOrderSamples(fixture, config, "seed", seededOrdersAreLinked(config)),
  runMeasuredOperation: ({ perfCase, context, config, fixture }) =>
    runLcpMeasuredOperation(perfCase, context, config, fixture),
  // buildResult already matches the driver arg shape; map the driver's single
  // bundled primaryMeasurement back to the legacy (totalMeasurement, primary)
  // split and delegate to the existing assembler unchanged.
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
      totalMeasurement: primaryMeasurement,
      primary: primaryMeasurement?.result,
      error,
    }),
  cleanup: cleanupLcpFixture,
};

// Apply smoke overrides once and alias the four-table prefix to the driver's
// single `tableNamePrefix`, so the driver derives the identical fallback table
// name and every downstream spec callback sees the overridden, aliased config.
const toLifecyclePerfCase = (perfCase: PerfCase): PerfCase => {
  const config = applySmokeOverrides(
    perfCase.config as LinkComputedPropagationCaseConfig,
  );
  return {
    ...perfCase,
    config: {
      ...config,
      tableNamePrefix: config.ordersTableNamePrefix,
    } as unknown as PerfCase["config"],
  };
};

export const runLinkComputedPropagationCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  runRecordMutationLifecycle(
    toLifecyclePerfCase(perfCase),
    context,
    linkComputedPropagationLifecycleSpec,
  );

export const seedLinkComputedPropagationCase = async (
  perfCase: PerfCase,
  context: PerfRunContext,
): Promise<PerfRunResult> =>
  seedRecordMutationLifecycle(
    toLifecyclePerfCase(perfCase),
    context,
    linkComputedPropagationLifecycleSpec,
  );
