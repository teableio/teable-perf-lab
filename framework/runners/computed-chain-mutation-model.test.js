import assert from "node:assert/strict";
import test from "node:test";

import {
  buildExpectedOrderState,
  resolveCascadeImpact,
} from "./computed-chain-mutation-model.ts";

const fixture = {
  userCount: 40,
  orderCount: 4_000,
  ordersPerUser: 100,
  purchaseGroupSize: 10,
  targetUserRow: 20,
};

test("one user mutation fans out to exactly 100 orders and 10 purchases", () => {
  assert.deepEqual(resolveCascadeImpact(fixture), {
    targetUserRow: 20,
    firstAffectedOrderRow: 1_901,
    lastAffectedOrderRow: 2_000,
    affectedOrderCount: 100,
    firstAffectedPurchaseRow: 191,
    lastAffectedPurchaseRow: 200,
    affectedPurchaseCount: 10,
    unaffectedOrderCount: 3_900,
  });
});

test("select flip changes the longest chain only inside the target user's fanout", () => {
  assert.equal(
    buildExpectedOrderState(fixture, 1_901, {
      mutation: "foreign-select",
      phase: "updated",
    }).orderCard,
    "ORDER Order 1901|V1:Paid:First-020 Last-020|user-020@example.test|L3|L4|L5",
  );
  assert.equal(
    buildExpectedOrderState(fixture, 1_900, {
      mutation: "foreign-select",
      phase: "updated",
    }).orderCard,
    "ORDER Order 1900|V1:Pending:First-019 Last-019|user-019@example.test|L3|L4|L5",
  );
  assert.equal(
    buildExpectedOrderState(fixture, 2_001, {
      mutation: "foreign-select",
      phase: "updated",
    }).orderCard,
    "ORDER Order 2001|V1:Pending:First-021 Last-021|user-021@example.test|L3|L4|L5",
  );
});

test("single text edit changes first_name while email and status remain controls", () => {
  const state = buildExpectedOrderState(fixture, 2_000, {
    mutation: "foreign-first-name",
    phase: "updated",
  });

  assert.equal(state.lookupFirstName, "First-020-updated");
  assert.equal(state.lookupEmail, "user-020@example.test");
  assert.equal(state.lookupStatus, "Pending");
  assert.equal(
    state.orderCard,
    "ORDER Order 2000|V1:Pending:First-020-updated Last-020|user-020@example.test|L3|L4|L5",
  );
});

test("formula expression update changes all orders without changing dependencies", () => {
  assert.equal(
    buildExpectedOrderState(fixture, 1, {
      mutation: "formula-expression",
      phase: "updated",
    }).orderCard,
    "ORDER Order 1|V2:Pending:First-001 Last-001|user-001@example.test|L3|L4|L5",
  );
  assert.equal(
    buildExpectedOrderState(fixture, 4_000, {
      mutation: "formula-expression",
      phase: "updated",
    }).orderCard,
    "ORDER Order 4000|V2:Pending:First-040 Last-040|user-040@example.test|L3|L4|L5",
  );
});
