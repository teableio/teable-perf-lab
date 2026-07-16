import assert from "node:assert/strict";
import test from "node:test";
import {
  buildExpectedOrderState,
  buildUserState,
  createdOrderRow,
  createdUserRow,
  finalOrderCount,
  finalUserCount,
  purchaseChildOrderRows,
  resolveCachedCompanionTableIds,
  resolveImpact,
  targetOrderRow,
  targetPurchaseRow,
} from "./customer-upsert-computed-flow-model.ts";

const shape = {
  userCount: 40,
  orderCount: 4_000,
  ordersPerUser: 100,
  purchaseGroupSize: 10,
  targetUserRow: 20,
};

test("cached companion ids must match the deterministic seed table names", () => {
  assert.deepEqual(
    resolveCachedCompanionTableIds({
      metadataUsersTableId: "tbl-users",
      metadataPurchaseTableId: "tbl-purchases",
      discoveredUsersTableId: "tbl-users",
      discoveredPurchaseTableId: "tbl-purchases",
    }),
    { usersTableId: "tbl-users", purchaseTableId: "tbl-purchases" },
  );
  assert.throws(
    () =>
      resolveCachedCompanionTableIds({
        metadataUsersTableId: "tbl-unrelated-victim",
        metadataPurchaseTableId: "tbl-purchases",
        discoveredUsersTableId: "tbl-users",
        discoveredPurchaseTableId: "tbl-purchases",
      }),
    /do not match seed table names/,
  );
});

test("update user then create order changes 100 existing orders plus the new order", () => {
  const scenario = "update-user-create-order";
  const impact = resolveImpact(shape, scenario);
  assert.equal(finalUserCount(shape, scenario), 40);
  assert.equal(finalOrderCount(shape, scenario), 4_001);
  assert.equal(impact.affectedOrderCount, 101);
  assert.equal(impact.unaffectedOrderCount, 3_900);
  assert.equal(impact.affectedPurchaseCount, 10);
  assert.deepEqual(
    impact.affectedPurchases,
    [191, 192, 193, 194, 195, 196, 197, 198, 199, 200],
  );

  const created = buildExpectedOrderState(
    shape,
    scenario,
    createdOrderRow(shape),
    "final",
  );
  assert.equal(created.userRow, 20);
  assert.equal(created.purchaseRow, 200);
  assert.equal(created.orderValues.status, "Paid");
  assert.equal(created.lookups.first_name, "First-020-updated");
  assert.match(created.formulas.order_card, /First-020-updated/);
});

test("update user then update order keeps counts stable and combines both writes", () => {
  const scenario = "update-user-update-order";
  const impact = resolveImpact(shape, scenario);
  assert.equal(finalUserCount(shape, scenario), 40);
  assert.equal(finalOrderCount(shape, scenario), 4_000);
  assert.equal(impact.affectedOrderCount, 100);
  assert.equal(impact.affectedPurchaseCount, 10);

  const target = buildExpectedOrderState(
    shape,
    scenario,
    targetOrderRow(shape),
    "final",
  );
  assert.equal(target.orderValues.status, "Paid");
  assert.equal(target.lookups.first_name, "First-020-updated");
  assert.match(target.formulas.profile_seed, /^Paid\|First-020-updated\|/);
});

test("create user then create order leaves all existing rows unchanged", () => {
  const scenario = "create-user-create-order";
  const impact = resolveImpact(shape, scenario);
  assert.equal(finalUserCount(shape, scenario), 41);
  assert.equal(finalOrderCount(shape, scenario), 4_001);
  assert.equal(impact.affectedOrderCount, 1);
  assert.equal(impact.unaffectedOrderCount, 4_000);
  assert.equal(impact.affectedPurchaseCount, 1);
  assert.deepEqual(impact.affectedPurchases, [200]);

  const createdUser = buildUserState(createdUserRow(shape), {
    shape,
    scenario,
    phase: "final",
  });
  assert.equal(createdUser.first_name, "First-041-created");

  const existing = buildExpectedOrderState(shape, scenario, 2_000, "final");
  const seeded = buildExpectedOrderState(shape, scenario, 2_000, "seed");
  assert.deepEqual(existing, seeded);
});

test("created order joins the target purchase as its eleventh child", () => {
  const rows = purchaseChildOrderRows(
    shape,
    "create-user-create-order",
    targetPurchaseRow(shape),
    "final",
  );
  assert.equal(rows.length, 11);
  assert.equal(rows.at(-1), createdOrderRow(shape));
});
