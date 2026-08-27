import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTED_FIELD_COUNTS,
  FIELD_COUNTS,
  affectedSubOrderRows,
  expectedPurificationComputed,
  expectedSubOrderComputed,
  expectedSubOrderExpressionCard,
  isMutatedPurificationRow,
  purificationRowBySubOrderRow,
  resolveMutationWindow,
  subOrderRowForPurification,
} from "./circular-link-propagation-workload.ts";

// The committed case config's model subset.
const config = {
  orderRowCount: 6_000,
  subOrderRowCount: 3_000,
  purificationRowCount: 500,
  plasmidRowCount: 3,
  orderPermutation: { multiplier: 7, offset: 3 },
  purificationSubOrderPermutation: { multiplier: 13, offset: 5 },
  purificationOrderPermutation: { multiplier: 11, offset: 2 },
  mutation: { startOffset: 0, recordCount: 10 },
};

test("field counts match the incident fingerprint totals", () => {
  assert.deepEqual(FIELD_COUNTS, {
    plasmid: 16,
    orders: 34,
    subOrders: 85,
    purification: 88,
  });
  // Every computed family count matches the fingerprint: SubOrders 6+7+3+8,
  // Purification 18+8+1+14.
  assert.deepEqual(COMPUTED_FIELD_COUNTS, {
    orders: 6,
    subOrders: 24,
    purification: 41,
  });
});

test("purification -> sub-order mapping is injective and deterministic", () => {
  const map = purificationRowBySubOrderRow(config);
  assert.equal(map.size, 500);
  assert.equal(subOrderRowForPurification(1, config), 6);
  assert.equal(map.get(6), 1);
  assert.equal(subOrderRowForPurification(2, config), 19);
});

test("mutation window and affected sub-orders", () => {
  assert.deepEqual(resolveMutationWindow(500, config.mutation), {
    startOffset: 0,
    recordCount: 10,
    endOffsetExclusive: 10,
  });
  assert.ok(isMutatedPurificationRow(1, config));
  assert.ok(isMutatedPurificationRow(10, config));
  assert.ok(!isMutatedPurificationRow(11, config));
  const affected = affectedSubOrderRows(config);
  assert.equal(affected.length, 10);
  assert.equal(new Set(affected).size, 10);
  assert.equal(affected[0], 6);
  assert.equal(affected[1], 19);
});

test("updated phase changes exactly the mutated expression chain", () => {
  const seedCard = expectedSubOrderExpressionCard(6, 1, config, "seed");
  const updatedCard = expectedSubOrderExpressionCard(6, 1, config, "updated");
  assert.equal(seedCard, "SO SubOrder 6 :: AE10 so-text-1-6");
  assert.equal(updatedCard, "SO SubOrder 6 :: AE1010 so-text-1-6");

  const seed = expectedSubOrderComputed(6, config, "seed", 1);
  const updated = expectedSubOrderComputed(6, config, "updated", 1);
  assert.deepEqual(seed.lu_p_expression_mg_l, { kind: "value", value: 10 });
  assert.deepEqual(updated.lu_p_expression_mg_l, {
    kind: "value",
    value: 1_010,
  });
  // Unrelated lookups are phase-stable.
  assert.deepEqual(seed.lu_p_batch_code, updated.lu_p_batch_code);
  assert.deepEqual(seed.lu_o_attr_01, updated.lu_o_attr_01);

  // An unmutated purification stays on its seed value even in updated phase.
  const unmutatedHost = subOrderRowForPurification(11, config);
  const unmutated = expectedSubOrderComputed(
    unmutatedHost,
    config,
    "updated",
    11,
  );
  assert.deepEqual(unmutated.lu_p_expression_mg_l, {
    kind: "value",
    value: 110,
  });
});

test("unlinked sub-orders expect empty purification lookups and skip circular formulas", () => {
  const expected = expectedSubOrderComputed(
    3_000,
    config,
    "updated",
    undefined,
  );
  assert.deepEqual(expected.lu_p_expression_mg_l, { kind: "empty" });
  assert.deepEqual(expected.lu_p_actual_expression, { kind: "empty" });
  assert.deepEqual(expected.so_expression_card, { kind: "skip" });
  assert.deepEqual(expected.so_is_expressible, { kind: "skip" });
  // Purification-independent formulas stay asserted.
  assert.equal(expected.so_formula_08.kind, "value");
});

test("purification chain card closes the circle through the sub-order formula", () => {
  const expected = expectedPurificationComputed(1, config, "updated");
  assert.deepEqual(expected.lu_so_title, {
    kind: "value",
    value: "SubOrder 6",
  });
  assert.deepEqual(expected.lu_so_expression_card, {
    kind: "value",
    value: "SO SubOrder 6 :: AE1010 so-text-1-6",
  });
  assert.deepEqual(expected.p_chain_card, {
    kind: "value",
    value: "P Purification 1 :: SO SubOrder 6 :: AE1010 so-text-1-6",
  });
  assert.deepEqual(expected.actual_expression, {
    kind: "value",
    value: "AE1010 so-text-1-6",
  });
});
