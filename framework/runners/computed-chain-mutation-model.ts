export type ComputedChainFixtureShape = {
  userCount: number;
  orderCount: number;
  ordersPerUser: number;
  purchaseGroupSize: number;
  targetUserRow: number;
};

export type ComputedChainMutation =
  | "formula-expression"
  | "formula-dependency-add"
  | "formula-dependency-replace"
  | "formula-dependency-remove"
  | "foreign-select"
  | "foreign-first-name";

export type ComputedChainFormulaDependencyMutation = Extract<
  ComputedChainMutation,
  | "formula-dependency-add"
  | "formula-dependency-replace"
  | "formula-dependency-remove"
>;

export type FormulaDependencyPlan = {
  before: string[];
  after: string[];
  added: string[];
  removed: string[];
};

export type ComputedChainPhase = "seed" | "updated";

export type CascadeImpact = {
  targetUserRow: number;
  firstAffectedOrderRow: number;
  lastAffectedOrderRow: number;
  affectedOrderCount: number;
  firstAffectedPurchaseRow: number;
  lastAffectedPurchaseRow: number;
  affectedPurchaseCount: number;
  unaffectedOrderCount: number;
};

const assertPositiveInteger = (name: string, value: number) => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, got ${value}`);
  }
};

export const assertComputedChainFixtureShape = (
  shape: ComputedChainFixtureShape,
) => {
  for (const [name, value] of Object.entries(shape)) {
    assertPositiveInteger(name, value);
  }
  if (shape.userCount * shape.ordersPerUser !== shape.orderCount) {
    throw new Error(
      `userCount * ordersPerUser must equal orderCount; got ${shape.userCount} * ${shape.ordersPerUser} != ${shape.orderCount}`,
    );
  }
  if (shape.orderCount % shape.purchaseGroupSize !== 0) {
    throw new Error(
      `orderCount must be divisible by purchaseGroupSize; got ${shape.orderCount} % ${shape.purchaseGroupSize}`,
    );
  }
  if (shape.ordersPerUser % shape.purchaseGroupSize !== 0) {
    throw new Error(
      `ordersPerUser must be divisible by purchaseGroupSize; got ${shape.ordersPerUser} % ${shape.purchaseGroupSize}`,
    );
  }
  if (shape.targetUserRow > shape.userCount) {
    throw new Error(
      `targetUserRow ${shape.targetUserRow} exceeds userCount ${shape.userCount}`,
    );
  }
};

export const userRowForOrder = (
  shape: ComputedChainFixtureShape,
  orderRow: number,
) => {
  assertComputedChainFixtureShape(shape);
  assertPositiveInteger("orderRow", orderRow);
  if (orderRow > shape.orderCount) {
    throw new Error(
      `orderRow ${orderRow} exceeds orderCount ${shape.orderCount}`,
    );
  }
  return Math.floor((orderRow - 1) / shape.ordersPerUser) + 1;
};

export const purchaseRowForOrder = (
  shape: ComputedChainFixtureShape,
  orderRow: number,
) => {
  userRowForOrder(shape, orderRow);
  return Math.floor((orderRow - 1) / shape.purchaseGroupSize) + 1;
};

export const resolveCascadeImpact = (
  shape: ComputedChainFixtureShape,
): CascadeImpact => {
  assertComputedChainFixtureShape(shape);
  const firstAffectedOrderRow =
    (shape.targetUserRow - 1) * shape.ordersPerUser + 1;
  const lastAffectedOrderRow = firstAffectedOrderRow + shape.ordersPerUser - 1;
  const firstAffectedPurchaseRow = purchaseRowForOrder(
    shape,
    firstAffectedOrderRow,
  );
  const lastAffectedPurchaseRow = purchaseRowForOrder(
    shape,
    lastAffectedOrderRow,
  );
  return {
    targetUserRow: shape.targetUserRow,
    firstAffectedOrderRow,
    lastAffectedOrderRow,
    affectedOrderCount: shape.ordersPerUser,
    firstAffectedPurchaseRow,
    lastAffectedPurchaseRow,
    affectedPurchaseCount:
      lastAffectedPurchaseRow - firstAffectedPurchaseRow + 1,
    unaffectedOrderCount: shape.orderCount - shape.ordersPerUser,
  };
};

export const isOrderAffectedByUserMutation = (
  shape: ComputedChainFixtureShape,
  orderRow: number,
) => userRowForOrder(shape, orderRow) === shape.targetUserRow;

const padded = (row: number) => String(row).padStart(3, "0");

const FORMULA_DEPENDENCIES_BEFORE = [
  "lookup_first_name",
  "lookup_last_name",
  "lookup_status",
] as const;

export const resolveFormulaDependencyPlan = (
  mutation: ComputedChainFormulaDependencyMutation,
): FormulaDependencyPlan => {
  const afterByMutation: Record<
    ComputedChainFormulaDependencyMutation,
    string[]
  > = {
    "formula-dependency-add": [
      "lookup_email",
      "lookup_first_name",
      "lookup_last_name",
      "lookup_status",
    ],
    "formula-dependency-replace": [
      "lookup_email",
      "lookup_first_name",
      "lookup_status",
    ],
    "formula-dependency-remove": ["lookup_first_name", "lookup_status"],
  };
  const before: string[] = [...FORMULA_DEPENDENCIES_BEFORE];
  const after = afterByMutation[mutation];
  return {
    before,
    after,
    added: after.filter((dependency) => !before.includes(dependency)),
    removed: before.filter((dependency) => !after.includes(dependency)),
  };
};

export const buildExpectedUserState = (
  userRow: number,
  options: {
    mutation: ComputedChainMutation;
    phase: ComputedChainPhase;
    targetUserRow: number;
  },
) => {
  assertPositiveInteger("userRow", userRow);
  const isUpdatedTarget =
    options.phase === "updated" && userRow === options.targetUserRow;
  return {
    firstName:
      options.mutation === "foreign-first-name" && isUpdatedTarget
        ? `First-${padded(userRow)}-updated`
        : `First-${padded(userRow)}`,
    lastName: `Last-${padded(userRow)}`,
    email: `user-${padded(userRow)}@example.test`,
    status:
      options.mutation === "foreign-select" && isUpdatedTarget
        ? "Paid"
        : "Pending",
  };
};

export const buildExpectedOrderState = (
  shape: ComputedChainFixtureShape,
  orderRow: number,
  options: {
    mutation: ComputedChainMutation;
    phase: ComputedChainPhase;
  },
) => {
  const userRow = userRowForOrder(shape, orderRow);
  const user = buildExpectedUserState(userRow, {
    ...options,
    targetUserRow: shape.targetUserRow,
  });
  let profileSeed = `V1:${user.status}:${user.firstName} ${user.lastName}`;
  if (options.phase === "updated") {
    switch (options.mutation) {
      case "formula-expression":
        profileSeed = `V2:${user.status}:${user.firstName} ${user.lastName}`;
        break;
      case "formula-dependency-add":
        profileSeed = `V2:${user.status}:${user.firstName} ${user.lastName}|${user.email}`;
        break;
      case "formula-dependency-replace":
        profileSeed = `V2:${user.status}:${user.firstName} ${user.email}`;
        break;
      case "formula-dependency-remove":
        profileSeed = `V2:${user.status}:${user.firstName}`;
        break;
    }
  }
  const profileL2 = `${profileSeed}|${user.email}`;
  const profileL3 = `${profileL2}|L3`;
  const profileL4 = `${profileL3}|L4`;
  const orderCard = `ORDER Order ${orderRow}|${profileL4}|L5`;
  return {
    userRow,
    lookupFirstName: user.firstName,
    lookupLastName: user.lastName,
    lookupEmail: user.email,
    lookupStatus: user.status,
    profileSeed,
    profileL2,
    profileL3,
    profileL4,
    orderCard,
  };
};
