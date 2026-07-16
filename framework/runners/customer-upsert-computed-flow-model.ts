export type CustomerUpsertScenario =
  | "update-user-create-order"
  | "update-user-update-order"
  | "create-user-create-order";

export type CustomerUpsertPhase = "seed" | "final";

export type CustomerUpsertFixtureShape = {
  userCount: number;
  orderCount: number;
  ordersPerUser: number;
  purchaseGroupSize: number;
  targetUserRow: number;
};

export const USER_ATTRIBUTE_NAMES = [
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

export type UserAttributeName = (typeof USER_ATTRIBUTE_NAMES)[number];

export const ORDER_VALUE_NAMES = [
  "Title",
  "status",
  "currency",
  "total",
  "customer_note",
  "payment_method",
  "transaction_id",
  "customer_ip_address",
  "created_via",
  "order_number",
] as const;

export type OrderValueName = (typeof ORDER_VALUE_NAMES)[number];

export const FORMULA_NAMES = [
  "profile_seed",
  "profile_l2",
  "profile_l3",
  "profile_l4",
  "order_card",
] as const;

export type FormulaName = (typeof FORMULA_NAMES)[number];

export const isUserCreateScenario = (scenario: CustomerUpsertScenario) =>
  scenario === "create-user-create-order";

export const isOrderCreateScenario = (scenario: CustomerUpsertScenario) =>
  scenario !== "update-user-update-order";

export const createdUserRow = (shape: CustomerUpsertFixtureShape) =>
  shape.userCount + 1;

export const createdOrderRow = (shape: CustomerUpsertFixtureShape) =>
  shape.orderCount + 1;

export const targetOrderRow = (shape: CustomerUpsertFixtureShape) =>
  shape.targetUserRow * shape.ordersPerUser;

export const targetPurchaseRow = (shape: CustomerUpsertFixtureShape) =>
  Math.ceil(targetOrderRow(shape) / shape.purchaseGroupSize);

export const userRowForOrder = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
  orderRow: number,
) => {
  if (orderRow === createdOrderRow(shape) && isOrderCreateScenario(scenario)) {
    return isUserCreateScenario(scenario)
      ? createdUserRow(shape)
      : shape.targetUserRow;
  }
  return Math.ceil(orderRow / shape.ordersPerUser);
};

export const purchaseRowForOrder = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
  orderRow: number,
) =>
  orderRow === createdOrderRow(shape) && isOrderCreateScenario(scenario)
    ? targetPurchaseRow(shape)
    : Math.ceil(orderRow / shape.purchaseGroupSize);

const pad = (value: number, width = 3) => String(value).padStart(width, "0");

export const userTitle = (row: number) => `User-${pad(row)}`;
export const orderTitle = (row: number) => `Order ${row}`;
export const purchaseTitle = (row: number) => `Purchase ${row}`;

export const buildUserState = (
  row: number,
  input: {
    shape: CustomerUpsertFixtureShape;
    scenario: CustomerUpsertScenario;
    phase: CustomerUpsertPhase;
  },
): Record<UserAttributeName, string> => {
  const isCreated =
    input.phase === "final" &&
    isUserCreateScenario(input.scenario) &&
    row === createdUserRow(input.shape);
  const isUpdated =
    input.phase === "final" &&
    !isUserCreateScenario(input.scenario) &&
    row === input.shape.targetUserRow;
  const suffix = pad(row);
  return {
    first_name: isCreated
      ? `First-${suffix}-created`
      : isUpdated
        ? `First-${suffix}-updated`
        : `First-${suffix}`,
    last_name: `Last-${suffix}`,
    email: `user-${suffix}@example.test`,
    phone: `+1-555-${String(row).padStart(4, "0")}`,
    address_1: `${row} Main Street`,
    address_2: `Suite ${row}`,
    country: "US",
    state: `State-${row % 5}`,
    postcode: String(10_000 + row),
    city: `City-${row % 7}`,
  };
};

export const buildOrderValues = (
  row: number,
  input: {
    shape: CustomerUpsertFixtureShape;
    scenario: CustomerUpsertScenario;
    phase: CustomerUpsertPhase;
  },
): Record<OrderValueName, string | number> => {
  const isCreated =
    input.phase === "final" &&
    isOrderCreateScenario(input.scenario) &&
    row === createdOrderRow(input.shape);
  const isUpdated =
    input.phase === "final" &&
    input.scenario === "update-user-update-order" &&
    row === targetOrderRow(input.shape);
  return {
    Title: orderTitle(row),
    status: isCreated || isUpdated ? "Paid" : "Pending",
    currency: "USD",
    total: row * 1.25,
    customer_note: `Note ${row}`,
    payment_method: row % 2 === 0 ? "card" : "paypal",
    transaction_id: `txn-${String(row).padStart(6, "0")}`,
    customer_ip_address: `192.0.2.${(row % 250) + 1}`,
    created_via: "woocommerce",
    order_number: `WC-${String(row).padStart(6, "0")}`,
  };
};

export type ExpectedOrderState = {
  row: number;
  userRow: number;
  purchaseRow: number;
  orderValues: Record<OrderValueName, string | number>;
  lookups: Record<UserAttributeName, string>;
  formulas: Record<FormulaName, string>;
};

export const buildExpectedOrderState = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
  row: number,
  phase: CustomerUpsertPhase,
): ExpectedOrderState => {
  const userRow = userRowForOrder(shape, scenario, row);
  const orderValues = buildOrderValues(row, { shape, scenario, phase });
  const lookups = buildUserState(userRow, { shape, scenario, phase });
  const profileSeed = [
    orderValues.status,
    ...USER_ATTRIBUTE_NAMES.map((name) => lookups[name]),
  ].join("|");
  const profileL2 = `${profileSeed}|L2`;
  const profileL3 = `${profileL2}|L3`;
  const profileL4 = `${profileL3}|L4`;
  return {
    row,
    userRow,
    purchaseRow: purchaseRowForOrder(shape, scenario, row),
    orderValues,
    lookups,
    formulas: {
      profile_seed: profileSeed,
      profile_l2: profileL2,
      profile_l3: profileL3,
      profile_l4: profileL4,
      order_card: `ORDER ${orderTitle(row)}|${profileL4}|L5`,
    },
  };
};

export const finalUserCount = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
) => shape.userCount + (isUserCreateScenario(scenario) ? 1 : 0);

export const finalOrderCount = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
) => shape.orderCount + (isOrderCreateScenario(scenario) ? 1 : 0);

export const isAffectedOrder = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
  row: number,
) => {
  if (isOrderCreateScenario(scenario) && row === createdOrderRow(shape)) {
    return true;
  }
  if (
    scenario !== "create-user-create-order" &&
    userRowForOrder(shape, scenario, row) === shape.targetUserRow
  ) {
    return true;
  }
  return false;
};

export const purchaseChildOrderRows = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
  purchaseRow: number,
  phase: CustomerUpsertPhase,
) => {
  const first = (purchaseRow - 1) * shape.purchaseGroupSize + 1;
  const rows = Array.from(
    { length: shape.purchaseGroupSize },
    (_, index) => first + index,
  );
  if (
    phase === "final" &&
    isOrderCreateScenario(scenario) &&
    purchaseRow === targetPurchaseRow(shape)
  ) {
    rows.push(createdOrderRow(shape));
  }
  return rows;
};

export const isAffectedPurchase = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
  purchaseRow: number,
) =>
  purchaseChildOrderRows(shape, scenario, purchaseRow, "final").some((row) =>
    isAffectedOrder(shape, scenario, row),
  );

export const resolveImpact = (
  shape: CustomerUpsertFixtureShape,
  scenario: CustomerUpsertScenario,
) => {
  const affectedOrders = Array.from(
    { length: finalOrderCount(shape, scenario) },
    (_, index) => index + 1,
  ).filter((row) => isAffectedOrder(shape, scenario, row));
  const purchaseCount = shape.orderCount / shape.purchaseGroupSize;
  const affectedPurchases = Array.from(
    { length: purchaseCount },
    (_, index) => index + 1,
  ).filter((row) => isAffectedPurchase(shape, scenario, row));
  return {
    affectedOrderCount: affectedOrders.length,
    unaffectedOrderCount:
      finalOrderCount(shape, scenario) - affectedOrders.length,
    affectedPurchaseCount: affectedPurchases.length,
    unaffectedPurchaseCount: purchaseCount - affectedPurchases.length,
    affectedOrders,
    affectedPurchases,
  };
};
