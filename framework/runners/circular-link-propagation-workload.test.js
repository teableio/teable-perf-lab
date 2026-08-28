import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTED_FIELD_COUNTS,
  FIELD_COUNTS,
  affectedSubOrderRows,
  appendedPurificationRowCount,
  appendedPurificationRows,
  expectedPurificationComputed,
  expectedSubOrderComputed,
  expectedSubOrderExpressionCard,
  isMutatedPlasmidRow,
  isMutatedPurificationRow,
  mutationTargetRowCount,
  purificationRowBySubOrderRow,
  purificationRowTotal,
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

test("plasmid-total mutation fans out to every host of the mutated plasmid row", () => {
  const plasmidConfig = {
    ...config,
    mutation: { startOffset: 0, recordCount: 1, kind: "plasmid-total" },
  };
  assert.equal(mutationTargetRowCount(plasmidConfig), 3);
  assert.ok(isMutatedPlasmidRow(1, plasmidConfig));
  assert.ok(!isMutatedPlasmidRow(2, plasmidConfig));
  // The purification-kind predicate must stay off for this mutation kind.
  assert.ok(!isMutatedPurificationRow(1, plasmidConfig));

  // Every third sub-order round-robins onto plasmid 1.
  const affected = affectedSubOrderRows(plasmidConfig);
  assert.equal(affected.length, 1_000);
  assert.equal(affected[0], 1);
  assert.equal(affected[1], 4);

  // Affected hosts flip clu_pl_total; everything else is phase-stable.
  const seed = expectedSubOrderComputed(1, plasmidConfig, "seed", undefined);
  const updated = expectedSubOrderComputed(
    1,
    plasmidConfig,
    "updated",
    undefined,
  );
  assert.deepEqual(seed.clu_pl_total, { kind: "value", value: 100 });
  assert.deepEqual(updated.clu_pl_total, { kind: "value", value: 5_100 });
  assert.deepEqual(seed.clu_pl_backbone, updated.clu_pl_backbone);

  // Hosts of unmutated plasmids stay on seed values even in updated phase.
  const untouched = expectedSubOrderComputed(
    2,
    plasmidConfig,
    "updated",
    undefined,
  );
  assert.deepEqual(untouched.clu_pl_total, { kind: "value", value: 200 });

  // Purification rows linked to plasmid 1 flip lu_pl_total the same way.
  const purification = expectedPurificationComputed(
    1,
    plasmidConfig,
    "updated",
  );
  assert.deepEqual(purification.lu_pl_total, { kind: "value", value: 5_100 });
  const untouchedPurification = expectedPurificationComputed(
    2,
    plasmidConfig,
    "updated",
  );
  assert.deepEqual(untouchedPurification.lu_pl_total, {
    kind: "value",
    value: 200,
  });
  // The circular expression chain is NOT part of this mutation's closure.
  assert.deepEqual(purification.lu_so_expression_card, {
    kind: "value",
    value: "SO SubOrder 6 :: AE10 so-text-1-6",
  });
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

// Codex review (PR #171): the append algebra previously had no unit test,
// which hid the startOffset discrepancy this block now pins down.
test("purification-append extends the seeded permutation and rejects offsets", () => {
  const appendConfig = {
    ...config,
    mutation: { startOffset: 0, recordCount: 4, kind: "purification-append" },
  };
  // Appended rows continue the injective permutation right after the seed.
  assert.deepEqual(
    appendedPurificationRows(appendConfig),
    [501, 502, 503, 504],
  );
  assert.equal(mutationTargetRowCount(appendConfig), 4);
  // Phase-aware totals: the appended rows exist only in the updated phase.
  assert.equal(appendedPurificationRowCount(appendConfig, "seed"), 0);
  assert.equal(appendedPurificationRowCount(appendConfig, "updated"), 4);
  assert.equal(purificationRowTotal(appendConfig, "seed"), 500);
  assert.equal(purificationRowTotal(appendConfig, "updated"), 504);
  // Other kinds never report appended rows.
  assert.deepEqual(appendedPurificationRows(config), []);
  assert.equal(purificationRowTotal(config, "updated"), 500);
  // Each appended row attaches to a distinct, previously purification-free
  // sub-order.
  const seededHosts = new Set(purificationRowBySubOrderRow(config).keys());
  const appendedHosts = appendedPurificationRows(appendConfig).map((row) =>
    subOrderRowForPurification(row, appendConfig),
  );
  assert.equal(new Set(appendedHosts).size, appendedHosts.length);
  for (const host of appendedHosts) {
    assert.ok(!seededHosts.has(host));
  }
  // startOffset has no defined meaning for append: appended rows always
  // extend the permutation, so a nonzero offset must fail loudly instead of
  // being silently ignored.
  assert.throws(
    () =>
      resolveMutationWindow(4, {
        startOffset: 1,
        recordCount: 3,
        kind: "purification-append",
      }),
    /startOffset is not supported for purification-append/,
  );
});
