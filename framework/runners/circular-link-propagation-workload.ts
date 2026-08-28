// Pure workload model for the circular-link-propagation runner. No Teable I/O.
//
// It encodes the 2026-08-27 CN production incident fixture ("antibody
// expression" base): a four-table graph whose SubOrders and Purification
// tables link to each other in BOTH directions and look each other up, with
// formulas layered on those lookups, plus TWO duplicate one-many links from
// SubOrders to Purification doubling the dependency edges. The measured
// operation edits a scalar (number) cell on Purification — the link child —
// and the storm propagates UP into SubOrders and then back into Purification's
// reverse lookups.
//
// Everything here is computable from row numbers and config so V1/V2 and
// reruns compare (Deterministic Data rule in .agents/checklist.md).

export type CircularPermutation = { multiplier: number; offset: number };

export type CircularLinkPhase = "seed" | "updated";

// "purification-expression" edits expression_mg_l on Purification rows (the
// incident's literal trigger). "plasmid-total" edits total_amount_mg on
// Plasmid rows — the 3-row conditional-lookup source; one cell dirties the
// conditional lookups of a third of SubOrders AND the plain lookups of a
// third of Purification simultaneously (the maximum-fanout suspect path).
// "purification-append" bulk-INSERTS recordCount new Purification rows
// (p = purificationRowCount+1 ...), each wiring all four link cells — the
// write-burst shape that loses computed propagation under the hybrid
// strategy (each insert batch's inline run races the previous batch's
// dispatched outbox task on the table advisory lock).
export type CircularLinkMutationKind =
  | "purification-expression"
  | "plasmid-total"
  | "purification-append";

export type CircularLinkMutationWindowConfig = {
  startOffset?: number;
  recordCount: number;
  kind?: CircularLinkMutationKind;
};

export const mutationKind = (
  mutation: CircularLinkMutationWindowConfig,
): CircularLinkMutationKind => mutation.kind ?? "purification-expression";

export type CircularLinkMutationWindow = {
  startOffset: number;
  recordCount: number;
  endOffsetExclusive: number;
};

// The scale + mapping subset of the case config the model needs.
export interface CircularLinkWorkloadConfig {
  orderRowCount: number;
  subOrderRowCount: number;
  purificationRowCount: number;
  plasmidRowCount: number;
  // subOrder row -> order row
  orderPermutation: CircularPermutation;
  // purification row -> subOrder row (must be injective: multiplier coprime
  // with subOrderRowCount and purificationRowCount <= subOrderRowCount)
  purificationSubOrderPermutation: CircularPermutation;
  // purification row -> order row
  purificationOrderPermutation: CircularPermutation;
  mutation: CircularLinkMutationWindowConfig;
}

// ---------------------------------------------------------------------------
// Field schema constants (names shared by the runner and the case markdown).
// Production fingerprint mapping is documented in the case markdown.
// ---------------------------------------------------------------------------

export const TITLE_FIELD = "Title";

export const SELECT_OPTIONS = ["alpha", "beta", "gamma"] as const;

// Plasmid (production "质粒库-细胞接收", 16 fields, conditional-lookup source).
export const PLASMID_TYPE_KEY_FIELD = "type_key";
export const PLASMID_TOTAL_FIELD = "total_amount_mg";
export const PLASMID_BACKBONE_FIELD = "vector_backbone";
export const PLASMID_GRADE_FIELD = "qc_grade";
export const PLASMID_NOTE_COUNT = 8;
export const PLASMID_METRIC_COUNT = 3;

// Orders (production "抗体订单", 34 fields, 6 computed).
export const ORDER_ATTR_COUNT = 6;
export const ORDER_TEXT_COUNT = 13;
export const ORDER_NUM_COUNT = 8;
export const ORDER_FORMULA_COUNT = 6;

// SubOrders (production "抗体子订单", 85 fields, the UPDATE victim table).
export const SUBORDER_TEXT_COUNT = 33;
export const SUBORDER_NUM_COUNT = 13;
export const SUBORDER_SELECT_COUNT = 7;
export const SUBORDER_DATE_COUNT = 2;
export const SUBORDER_PLASMID_TYPE_KEY_FIELD = "plasmid_type_key";
export const SUBORDER_ORDER_LINK_FIELD = "so_order_link";
export const SUBORDER_PLASMID_LINK_FIELD = "so_plasmid_link";
// The duplicate one-many pair (production "表达-纯化" and "表达-纯化 (linked)").
export const SUBORDER_PURIFICATION_LINK_FIELD = "so_purification_link";
export const SUBORDER_PURIFICATION_LINK_DUP_FIELD = "so_purification_link_dup";

// Purification (production "表达-纯化", 88 fields, 41 computed, edit source).
export const PURIFICATION_EXPRESSION_FIELD = "expression_mg_l";
export const PURIFICATION_BATCH_FIELD = "batch_code";
export const PURIFICATION_OPERATOR_FIELD = "operator";
export const PURIFICATION_METHOD_FIELD = "method";
export const PURIFICATION_PURITY_FIELD = "purity_pct";
export const PURIFICATION_YIELD_FIELD = "yield_score";
export const PURIFICATION_TEXT_COUNT = 24;
export const PURIFICATION_NUM_COUNT = 10;
export const PURIFICATION_SELECT_COUNT = 2;
export const PURIFICATION_PLASMID_LINK_FIELD = "p_plasmid_link";
export const PURIFICATION_ORDER_LINK_FIELD = "p_order_link";

const pad2 = (index: number) => String(index).padStart(2, "0");

export const numberedField = (prefix: string, index: number) =>
  `${prefix}_${pad2(index)}`;

// ---------------------------------------------------------------------------
// Row mappings
// ---------------------------------------------------------------------------

const permutedRow = (
  row: number,
  targetCount: number,
  permutation: CircularPermutation,
) =>
  (((row - 1) * permutation.multiplier + permutation.offset) % targetCount) + 1;

export const orderRowForSubOrder = (
  subOrderRow: number,
  config: CircularLinkWorkloadConfig,
) => permutedRow(subOrderRow, config.orderRowCount, config.orderPermutation);

export const subOrderRowForPurification = (
  purificationRow: number,
  config: CircularLinkWorkloadConfig,
) =>
  permutedRow(
    purificationRow,
    config.subOrderRowCount,
    config.purificationSubOrderPermutation,
  );

export const orderRowForPurification = (
  purificationRow: number,
  config: CircularLinkWorkloadConfig,
) =>
  permutedRow(
    purificationRow,
    config.orderRowCount,
    config.purificationOrderPermutation,
  );

export const plasmidRowForSubOrder = (
  subOrderRow: number,
  config: CircularLinkWorkloadConfig,
) => ((subOrderRow - 1) % config.plasmidRowCount) + 1;

export const plasmidRowForPurification = (
  purificationRow: number,
  config: CircularLinkWorkloadConfig,
) => ((purificationRow - 1) % config.plasmidRowCount) + 1;

// Injective purification -> subOrder mapping proof + inverse map. Each
// purification attaches to a distinct subOrder, so subOrders carry 0 or 1
// purification (single-element one-many lookups keep expected values exact).
// In the updated phase of the append kind the appended rows extend the same
// permutation, so injectivity is proven over the extended range too.
export const purificationRowBySubOrderRow = (
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase = "seed",
): Map<number, number> => {
  const map = new Map<number, number>();
  for (let p = 1; p <= purificationRowTotal(config, phase); p += 1) {
    const s = subOrderRowForPurification(p, config);
    if (map.has(s)) {
      throw new Error(
        `purificationSubOrderPermutation is not injective: subOrder ${s} maps from purifications ${map.get(s)} and ${p}`,
      );
    }
    map.set(s, p);
  }
  return map;
};

// ---------------------------------------------------------------------------
// Mutation window
// ---------------------------------------------------------------------------

export const resolveMutationWindow = (
  purificationRowCount: number,
  mutation: CircularLinkMutationWindowConfig,
): CircularLinkMutationWindow => {
  const startOffset = mutation.startOffset ?? 0;
  const { recordCount } = mutation;
  if (!Number.isInteger(startOffset) || startOffset < 0) {
    throw new Error(
      `mutation.startOffset must be a non-negative integer, got ${startOffset}`,
    );
  }
  // Codex review (PR #171): appended rows always extend the seeded
  // permutation from purificationRowCount + 1, so an offset has no defined
  // meaning for the append kind — fail loudly instead of silently ignoring
  // it (appendedPurificationRows never consults it).
  if (mutationKind(mutation) === "purification-append" && startOffset !== 0) {
    throw new Error(
      "mutation.startOffset is not supported for purification-append; appended rows always extend the seeded permutation",
    );
  }
  if (!Number.isInteger(recordCount) || recordCount <= 0) {
    throw new Error(
      `mutation.recordCount must be a positive integer, got ${recordCount}`,
    );
  }
  const endOffsetExclusive = startOffset + recordCount;
  if (endOffsetExclusive > purificationRowCount) {
    throw new Error(
      `mutation window [${startOffset}, ${endOffsetExclusive}) exceeds purificationRowCount ${purificationRowCount}`,
    );
  }
  return { startOffset, recordCount, endOffsetExclusive };
};

// Row count of the table the mutation window ranges over. For the append
// kind the window ranges over the appended rows themselves.
export const mutationTargetRowCount = (config: CircularLinkWorkloadConfig) => {
  switch (mutationKind(config.mutation)) {
    case "plasmid-total":
      return config.plasmidRowCount;
    case "purification-append":
      return config.mutation.recordCount;
    default:
      return config.purificationRowCount;
  }
};

// Number of Purification rows that exist beyond the seeded set in a phase.
export const appendedPurificationRowCount = (
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
) =>
  mutationKind(config.mutation) === "purification-append" && phase === "updated"
    ? config.mutation.recordCount
    : 0;

export const purificationRowTotal = (
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
) => config.purificationRowCount + appendedPurificationRowCount(config, phase);

// The appended row numbers (empty for other mutation kinds).
export const appendedPurificationRows = (config: CircularLinkWorkloadConfig) =>
  mutationKind(config.mutation) === "purification-append"
    ? Array.from(
        { length: config.mutation.recordCount },
        (_, index) => config.purificationRowCount + index + 1,
      )
    : [];

export const isMutatedPurificationRow = (
  purificationRow: number,
  config: CircularLinkWorkloadConfig,
) => {
  if (mutationKind(config.mutation) !== "purification-expression") {
    return false;
  }
  const window = resolveMutationWindow(
    config.purificationRowCount,
    config.mutation,
  );
  const offset = purificationRow - 1;
  return offset >= window.startOffset && offset < window.endOffsetExclusive;
};

export const isMutatedPlasmidRow = (
  plasmidRow: number,
  config: CircularLinkWorkloadConfig,
) => {
  if (mutationKind(config.mutation) !== "plasmid-total") {
    return false;
  }
  const window = resolveMutationWindow(config.plasmidRowCount, config.mutation);
  const offset = plasmidRow - 1;
  return offset >= window.startOffset && offset < window.endOffsetExclusive;
};

// SubOrder rows directly dirtied by the mutation: for the purification kind
// the rows whose linked purification is inside the window; for the plasmid
// kind every row whose round-robin plasmid is inside the window (the
// conditional-lookup fanout — a third of the table per plasmid row).
export const affectedSubOrderRows = (config: CircularLinkWorkloadConfig) => {
  if (mutationKind(config.mutation) === "plasmid-total") {
    const rows: number[] = [];
    for (let s = 1; s <= config.subOrderRowCount; s += 1) {
      if (isMutatedPlasmidRow(plasmidRowForSubOrder(s, config), config)) {
        rows.push(s);
      }
    }
    return rows;
  }
  if (mutationKind(config.mutation) === "purification-append") {
    return appendedPurificationRows(config).map((p) =>
      subOrderRowForPurification(p, config),
    );
  }
  const window = resolveMutationWindow(
    config.purificationRowCount,
    config.mutation,
  );
  const rows: number[] = [];
  for (
    let offset = window.startOffset;
    offset < window.endOffsetExclusive;
    offset += 1
  ) {
    rows.push(subOrderRowForPurification(offset + 1, config));
  }
  return rows;
};

// ---------------------------------------------------------------------------
// Deterministic seed values
// ---------------------------------------------------------------------------

export const plasmidTitle = (n: number) => `Plasmid ${n}`;
export const plasmidTypeKey = (n: number) => `ptype-${n}`;
export const plasmidTotalAmount = (n: number) => 100 * n;
export const updatedPlasmidTotalValue = (n: number) =>
  plasmidTotalAmount(n) + 5_000;
export const expectedPlasmidTotalValue = (
  n: number,
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
) =>
  phase === "updated" && isMutatedPlasmidRow(n, config)
    ? updatedPlasmidTotalValue(n)
    : plasmidTotalAmount(n);
export const plasmidBackbone = (n: number) => `pl-backbone-${n}`;
export const plasmidGrade = (n: number) => `pl-grade-${n}`;
export const plasmidNote = (i: number, n: number) => `pl-note-${i}-${n}`;
export const plasmidMetric = (i: number, n: number) => n * 10 + i;

export const orderTitle = (n: number) => `Order ${n}`;
export const orderAttr = (i: number, n: number) => `o-attr-${i}-${n}`;
export const orderText = (i: number, n: number) => `o-text-${i}-${n}`;
export const orderNum = (i: number, n: number) => n * 100 + i;
export const expectedOrderFormula = (i: number, n: number) =>
  `OF${i} ${orderAttr(i, n)}`;

export const subOrderTitle = (s: number) => `SubOrder ${s}`;
export const subOrderText = (i: number, s: number) => `so-text-${i}-${s}`;
export const subOrderNum = (i: number, s: number) => s * 10 + i;
export const subOrderSelect = (i: number, s: number) =>
  SELECT_OPTIONS[(s + i) % SELECT_OPTIONS.length]!;
export const subOrderDate = () => "2026-08-27";
export const subOrderPlasmidTypeKey = (
  s: number,
  config: CircularLinkWorkloadConfig,
) => plasmidTypeKey(plasmidRowForSubOrder(s, config));

export const purificationTitle = (p: number) => `Purification ${p}`;
export const seedExpressionValue = (p: number) => p * 10;
export const updatedExpressionValue = (p: number) => p * 10 + 1000;
export const expectedExpressionValue = (
  p: number,
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
) =>
  phase === "updated" && isMutatedPurificationRow(p, config)
    ? updatedExpressionValue(p)
    : seedExpressionValue(p);
export const purificationBatchCode = (p: number) => `p-batch-${p}`;
export const purificationOperator = (p: number) => `p-oper-${p}`;
export const purificationMethod = (p: number) => `p-method-${p}`;
export const purificationPurity = (p: number) => (p % 50) + 50;
export const purificationYield = (p: number) => p * 3;
export const purificationText = (i: number, p: number) => `p-text-${i}-${p}`;
export const purificationNum = (i: number, p: number) => p * 7 + i;
export const purificationSelect = (i: number, p: number) =>
  SELECT_OPTIONS[(p + i) % SELECT_OPTIONS.length]!;

// ---------------------------------------------------------------------------
// Computed-field schema (names, targets, expressions)
// ---------------------------------------------------------------------------

// "formula" marks lookups whose target is a formula field: Teable requires the
// lookup's declared `type` to equal the looked-up field's type (a lookup of a
// formula must be created with type "formula"), while its cell value stays the
// formula's string result.
export type LookupValueKind = "text" | "number" | "select" | "link" | "formula";

export type LookupSpec = {
  name: string;
  target: string;
  kind: LookupValueKind;
};

// SubOrders: 6 lookups over the many-one order link.
export const SUBORDER_ORDER_LOOKUPS: LookupSpec[] = Array.from(
  { length: ORDER_ATTR_COUNT },
  (_, index) => ({
    name: numberedField("lu_o_attr", index + 1),
    target: numberedField("o_attr", index + 1),
    kind: "text",
  }),
);

// SubOrders: 3 conditional lookups against Plasmid (filter on type_key, no
// link field involved — mirrors the production conditional lookups).
export const SUBORDER_PLASMID_CONDITIONAL_LOOKUPS: LookupSpec[] = [
  { name: "clu_pl_total", target: PLASMID_TOTAL_FIELD, kind: "number" },
  { name: "clu_pl_backbone", target: PLASMID_BACKBONE_FIELD, kind: "text" },
  { name: "clu_pl_grade", target: PLASMID_GRADE_FIELD, kind: "text" },
];

// SubOrders: 7 lookups over the one-many purification link, including one that
// pulls the Purification formula `actual_expression` (production 实际表达量 —
// the formula-over-lookup carried through a lookup).
export const SUBORDER_PURIFICATION_LOOKUPS: LookupSpec[] = [
  {
    name: "lu_p_expression_mg_l",
    target: PURIFICATION_EXPRESSION_FIELD,
    kind: "number",
  },
  { name: "lu_p_batch_code", target: PURIFICATION_BATCH_FIELD, kind: "text" },
  { name: "lu_p_operator", target: PURIFICATION_OPERATOR_FIELD, kind: "text" },
  { name: "lu_p_method", target: PURIFICATION_METHOD_FIELD, kind: "text" },
  {
    name: "lu_p_purity_pct",
    target: PURIFICATION_PURITY_FIELD,
    kind: "number",
  },
  {
    name: "lu_p_yield_score",
    target: PURIFICATION_YIELD_FIELD,
    kind: "number",
  },
  {
    name: "lu_p_actual_expression",
    target: "actual_expression",
    kind: "formula",
  },
];

// Purification: 18 reverse lookups into SubOrders (9 text / 4 select /
// 4 number / 1 link), split across the two symmetric link fields so the
// duplicate link genuinely doubles the active dependency edges.
// `lu_so_expression_card` targets a SubOrders formula, closing the circle.
export type ReverseLookupSpec = LookupSpec & {
  via: "backref" | "backref-dup";
};

export const PURIFICATION_SUBORDER_LOOKUPS: ReverseLookupSpec[] = [
  { name: "lu_so_title", target: TITLE_FIELD, kind: "text", via: "backref" },
  ...[1, 2, 3, 4].map(
    (i): ReverseLookupSpec => ({
      name: numberedField("lu_so_text", i),
      target: numberedField("so_text", i),
      kind: "text",
      via: "backref",
    }),
  ),
  ...[1, 2].map(
    (i): ReverseLookupSpec => ({
      name: numberedField("lu_so_select", i),
      target: numberedField("so_select", i),
      kind: "select",
      via: "backref",
    }),
  ),
  ...[1, 2].map(
    (i): ReverseLookupSpec => ({
      name: numberedField("lu_so_num", i),
      target: numberedField("so_num", i),
      kind: "number",
      via: "backref",
    }),
  ),
  ...[5, 6, 7].map(
    (i): ReverseLookupSpec => ({
      name: numberedField("lu_so_text", i),
      target: numberedField("so_text", i),
      kind: "text",
      via: "backref-dup",
    }),
  ),
  {
    name: "lu_so_expression_card",
    target: "so_expression_card",
    kind: "formula",
    via: "backref-dup",
  },
  ...[3, 4].map(
    (i): ReverseLookupSpec => ({
      name: numberedField("lu_so_select", i),
      target: numberedField("so_select", i),
      kind: "select",
      via: "backref-dup",
    }),
  ),
  ...[3, 4].map(
    (i): ReverseLookupSpec => ({
      name: numberedField("lu_so_num", i),
      target: numberedField("so_num", i),
      kind: "number",
      via: "backref-dup",
    }),
  ),
  {
    name: "lu_so_link_order",
    target: SUBORDER_ORDER_LINK_FIELD,
    kind: "link",
    via: "backref-dup",
  },
];

// Purification: 8 lookups over its own plasmid link.
export const PURIFICATION_PLASMID_LOOKUPS: LookupSpec[] = [
  { name: "lu_pl_total", target: PLASMID_TOTAL_FIELD, kind: "number" },
  { name: "lu_pl_backbone", target: PLASMID_BACKBONE_FIELD, kind: "text" },
  { name: "lu_pl_grade", target: PLASMID_GRADE_FIELD, kind: "text" },
  ...[1, 2, 3, 4].map(
    (i): LookupSpec => ({
      name: numberedField("lu_pl_note", i),
      target: numberedField("pl_note", i),
      kind: "text",
    }),
  ),
  {
    name: "lu_pl_metric_01",
    target: numberedField("pl_metric", 1),
    kind: "number",
  },
];

// Purification: 1 lookup over its own order link.
export const PURIFICATION_ORDER_LOOKUPS: LookupSpec[] = [
  { name: "lu_o_title", target: TITLE_FIELD, kind: "text" },
];

export type FormulaSpec = {
  name: string;
  // {field-name} refs are compiled to {field-id} by the runner.
  expression: string;
  // Creation wave: formulas that reference late-created lookups must wait.
  wave: 1 | 2;
};

// Orders: 6 own-field formulas (schema fidelity; unaffected by the storm).
export const ORDER_FORMULAS: FormulaSpec[] = Array.from(
  { length: ORDER_FORMULA_COUNT },
  (_, index) => ({
    name: numberedField("o_formula", index + 1),
    expression: `"OF${index + 1} " & {${numberedField("o_attr", index + 1)}}`,
    wave: 1,
  }),
);

// SubOrders: 8 formulas. so_expression_card is the storm edge (formula over
// the cross-table purification lookup, itself looked back up by
// Purification's lu_so_expression_card).
export const SUBORDER_FORMULAS: FormulaSpec[] = [
  {
    name: "so_expression_card",
    expression: `"SO " & {${TITLE_FIELD}} & " :: " & {lu_p_actual_expression}`,
    wave: 1,
  },
  {
    name: "so_supply_ratio",
    expression: `"H1 " & {clu_pl_backbone} & " x" & {${numberedField("so_num", 1)}}`,
    wave: 1,
  },
  {
    name: "so_is_expressible",
    expression: `IF({lu_p_batch_code}, "YES", "NO") & "-" & {clu_pl_grade}`,
    wave: 1,
  },
  {
    name: "so_formula_04",
    expression: `"SF4 " & {${numberedField("lu_o_attr", 1)}}`,
    wave: 1,
  },
  {
    name: "so_formula_05",
    expression: `"SF5 " & {${numberedField("lu_o_attr", 2)}} & " " & {${numberedField("so_text", 1)}}`,
    wave: 1,
  },
  {
    name: "so_formula_06",
    expression: `"SF6 " & {${SUBORDER_PLASMID_TYPE_KEY_FIELD}}`,
    wave: 1,
  },
  {
    name: "so_formula_07",
    expression: `{${numberedField("so_num", 2)}} + {${numberedField("so_num", 3)}}`,
    wave: 1,
  },
  {
    name: "so_formula_08",
    expression: `"SF8 " & {${TITLE_FIELD}}`,
    wave: 1,
  },
];

// Purification: 14 formulas. actual_expression is the production 实际表达量
// analog (formula over the edited cell + a reverse lookup); p_chain_card sits
// on the reverse lookup of the SubOrders formula, closing the circular
// dependency SubOrders ⇄ Purification.
export const PURIFICATION_FORMULAS: FormulaSpec[] = [
  {
    name: "actual_expression",
    expression: `"AE" & {${PURIFICATION_EXPRESSION_FIELD}} & " " & {${numberedField("lu_so_text", 1)}}`,
    wave: 1,
  },
  {
    name: "p_chain_card",
    expression: `"P " & {${TITLE_FIELD}} & " :: " & {lu_so_expression_card}`,
    wave: 2,
  },
  {
    name: "p_formula_03",
    expression: `"PF3 " & {${PURIFICATION_BATCH_FIELD}}`,
    wave: 1,
  },
  {
    name: "p_formula_04",
    expression: `"PF4 " & {${PURIFICATION_OPERATOR_FIELD}} & " " & {${PURIFICATION_METHOD_FIELD}}`,
    wave: 1,
  },
  {
    name: "p_formula_05",
    expression: `{${PURIFICATION_PURITY_FIELD}} + {${PURIFICATION_YIELD_FIELD}}`,
    wave: 1,
  },
  { name: "p_formula_06", expression: `"PF6 " & {lu_so_title}`, wave: 1 },
  { name: "p_formula_07", expression: `"PF7 " & {lu_pl_backbone}`, wave: 1 },
  { name: "p_formula_08", expression: `"PF8 " & {lu_o_title}`, wave: 1 },
  {
    name: "p_formula_09",
    expression: `"PF9 " & {${numberedField("p_text", 1)}}`,
    wave: 1,
  },
  {
    name: "p_formula_10",
    expression: `"PF10 " & {${numberedField("lu_so_select", 1)}}`,
    wave: 1,
  },
  {
    name: "p_formula_11",
    expression: `"PF11 " & {${numberedField("p_select", 1)}}`,
    wave: 1,
  },
  {
    name: "p_formula_12",
    expression: `"PF12 " & {${numberedField("lu_so_text", 2)}}`,
    wave: 1,
  },
  { name: "p_formula_13", expression: `"PF13 " & {${TITLE_FIELD}}`, wave: 1 },
  { name: "p_formula_14", expression: `"PF14 " & {lu_pl_grade}`, wave: 1 },
];

// ---------------------------------------------------------------------------
// Field-count audit (kept executable so drift from the documented incident
// fingerprint mapping fails the unit test, not a human review).
// ---------------------------------------------------------------------------

export const FIELD_COUNTS = {
  plasmid:
    // Title + type_key + total + backbone + grade + notes + metrics
    5 + PLASMID_NOTE_COUNT + PLASMID_METRIC_COUNT,
  orders:
    1 +
    ORDER_ATTR_COUNT +
    ORDER_TEXT_COUNT +
    ORDER_NUM_COUNT +
    ORDER_FORMULAS.length,
  subOrders:
    // Title + plasmid_type_key + plain text/num/select/date + 4 links +
    // 6 order lookups + 3 conditional plasmid lookups + 7 purification
    // lookups + 8 formulas
    2 +
    SUBORDER_TEXT_COUNT +
    SUBORDER_NUM_COUNT +
    SUBORDER_SELECT_COUNT +
    SUBORDER_DATE_COUNT +
    4 +
    SUBORDER_ORDER_LOOKUPS.length +
    SUBORDER_PLASMID_CONDITIONAL_LOOKUPS.length +
    SUBORDER_PURIFICATION_LOOKUPS.length +
    SUBORDER_FORMULAS.length,
  purification:
    // Title + 6 named plain + text/num/select filler + 2 own links + 2
    // symmetric backrefs + 18 reverse lookups + 8 plasmid lookups + 1 order
    // lookup + 14 formulas
    7 +
    PURIFICATION_TEXT_COUNT +
    PURIFICATION_NUM_COUNT +
    PURIFICATION_SELECT_COUNT +
    4 +
    PURIFICATION_SUBORDER_LOOKUPS.length +
    PURIFICATION_PLASMID_LOOKUPS.length +
    PURIFICATION_ORDER_LOOKUPS.length +
    PURIFICATION_FORMULAS.length,
} as const;

export const COMPUTED_FIELD_COUNTS = {
  orders: ORDER_FORMULAS.length,
  subOrders:
    SUBORDER_ORDER_LOOKUPS.length +
    SUBORDER_PLASMID_CONDITIONAL_LOOKUPS.length +
    SUBORDER_PURIFICATION_LOOKUPS.length +
    SUBORDER_FORMULAS.length,
  purification:
    PURIFICATION_SUBORDER_LOOKUPS.length +
    PURIFICATION_PLASMID_LOOKUPS.length +
    PURIFICATION_ORDER_LOOKUPS.length +
    PURIFICATION_FORMULAS.length,
} as const;

// ---------------------------------------------------------------------------
// Expected computed values
// ---------------------------------------------------------------------------

export type ExpectedCell =
  | { kind: "value"; value: string | number }
  | { kind: "empty" }
  // Deliberately unasserted: rendering of blank-lookup formulas is not part of
  // the case contract (see the case markdown assumptions).
  | { kind: "skip" };

const value = (v: string | number): ExpectedCell => ({
  kind: "value",
  value: v,
});
const empty: ExpectedCell = { kind: "empty" };
const skip: ExpectedCell = { kind: "skip" };

export const expectedActualExpression = (
  p: number,
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
) =>
  `AE${expectedExpressionValue(p, config, phase)} ${subOrderText(
    1,
    subOrderRowForPurification(p, config),
  )}`;

export const expectedSubOrderExpressionCard = (
  s: number,
  p: number,
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
) => `SO ${subOrderTitle(s)} :: ${expectedActualExpression(p, config, phase)}`;

// Expected computed state of one SubOrders row: field name -> expectation.
export const expectedSubOrderComputed = (
  s: number,
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
  purificationRow: number | undefined,
): Record<string, ExpectedCell> => {
  const o = orderRowForSubOrder(s, config);
  const k = plasmidRowForSubOrder(s, config);
  const expected: Record<string, ExpectedCell> = {};
  for (const spec of SUBORDER_ORDER_LOOKUPS) {
    const i = Number(spec.target.slice("o_attr_".length));
    expected[spec.name] = value(orderAttr(i, o));
  }
  expected.clu_pl_total = value(expectedPlasmidTotalValue(k, config, phase));
  expected.clu_pl_backbone = value(plasmidBackbone(k));
  expected.clu_pl_grade = value(plasmidGrade(k));

  const p = purificationRow;
  if (p === undefined) {
    for (const spec of SUBORDER_PURIFICATION_LOOKUPS) {
      expected[spec.name] = empty;
    }
    expected.so_expression_card = skip;
    expected.so_is_expressible = skip;
  } else {
    expected.lu_p_expression_mg_l = value(
      expectedExpressionValue(p, config, phase),
    );
    expected.lu_p_batch_code = value(purificationBatchCode(p));
    expected.lu_p_operator = value(purificationOperator(p));
    expected.lu_p_method = value(purificationMethod(p));
    expected.lu_p_purity_pct = value(purificationPurity(p));
    expected.lu_p_yield_score = value(purificationYield(p));
    expected.lu_p_actual_expression = value(
      expectedActualExpression(p, config, phase),
    );
    expected.so_expression_card = value(
      expectedSubOrderExpressionCard(s, p, config, phase),
    );
    expected.so_is_expressible = value(`YES-${plasmidGrade(k)}`);
  }

  expected.so_supply_ratio = value(
    `H1 ${plasmidBackbone(k)} x${subOrderNum(1, s)}`,
  );
  expected.so_formula_04 = value(`SF4 ${orderAttr(1, o)}`);
  expected.so_formula_05 = value(
    `SF5 ${orderAttr(2, o)} ${subOrderText(1, s)}`,
  );
  expected.so_formula_06 = value(`SF6 ${plasmidTypeKey(k)}`);
  expected.so_formula_07 = value(subOrderNum(2, s) + subOrderNum(3, s));
  expected.so_formula_08 = value(`SF8 ${subOrderTitle(s)}`);
  return expected;
};

// Expected computed state of one Purification row.
export const expectedPurificationComputed = (
  p: number,
  config: CircularLinkWorkloadConfig,
  phase: CircularLinkPhase,
): Record<string, ExpectedCell> => {
  const s = subOrderRowForPurification(p, config);
  const o = orderRowForPurification(p, config);
  const k = plasmidRowForPurification(p, config);
  const soPlasmid = plasmidRowForSubOrder(s, config);
  const expected: Record<string, ExpectedCell> = {};

  for (const spec of PURIFICATION_SUBORDER_LOOKUPS) {
    if (spec.target === TITLE_FIELD) {
      expected[spec.name] = value(subOrderTitle(s));
    } else if (spec.target.startsWith("so_text_")) {
      expected[spec.name] = value(
        subOrderText(Number(spec.target.slice("so_text_".length)), s),
      );
    } else if (spec.target.startsWith("so_select_")) {
      expected[spec.name] = value(
        subOrderSelect(Number(spec.target.slice("so_select_".length)), s),
      );
    } else if (spec.target.startsWith("so_num_")) {
      expected[spec.name] = value(
        subOrderNum(Number(spec.target.slice("so_num_".length)), s),
      );
    } else if (spec.target === SUBORDER_ORDER_LINK_FIELD) {
      expected[spec.name] = value(orderTitle(orderRowForSubOrder(s, config)));
    } else if (spec.target === "so_expression_card") {
      expected[spec.name] = value(
        expectedSubOrderExpressionCard(s, p, config, phase),
      );
    } else {
      throw new Error(`Unmapped reverse lookup target ${spec.target}`);
    }
  }

  expected.lu_pl_total = value(expectedPlasmidTotalValue(k, config, phase));
  expected.lu_pl_backbone = value(plasmidBackbone(k));
  expected.lu_pl_grade = value(plasmidGrade(k));
  for (const i of [1, 2, 3, 4]) {
    expected[numberedField("lu_pl_note", i)] = value(plasmidNote(i, k));
  }
  expected.lu_pl_metric_01 = value(plasmidMetric(1, k));
  expected.lu_o_title = value(orderTitle(o));

  expected.actual_expression = value(
    expectedActualExpression(p, config, phase),
  );
  expected.p_chain_card = value(
    `P ${purificationTitle(p)} :: ${expectedSubOrderExpressionCard(s, p, config, phase)}`,
  );
  expected.p_formula_03 = value(`PF3 ${purificationBatchCode(p)}`);
  expected.p_formula_04 = value(
    `PF4 ${purificationOperator(p)} ${purificationMethod(p)}`,
  );
  expected.p_formula_05 = value(purificationPurity(p) + purificationYield(p));
  expected.p_formula_06 = value(`PF6 ${subOrderTitle(s)}`);
  expected.p_formula_07 = value(`PF7 ${plasmidBackbone(k)}`);
  expected.p_formula_08 = value(`PF8 ${orderTitle(o)}`);
  expected.p_formula_09 = value(`PF9 ${purificationText(1, p)}`);
  expected.p_formula_10 = value(`PF10 ${subOrderSelect(1, s)}`);
  expected.p_formula_11 = value(`PF11 ${purificationSelect(1, p)}`);
  expected.p_formula_12 = value(`PF12 ${subOrderText(2, s)}`);
  expected.p_formula_13 = value(`PF13 ${purificationTitle(p)}`);
  expected.p_formula_14 = value(`PF14 ${plasmidGrade(k)}`);
  // Unused variable guard: soPlasmid participates only through
  // so_expression_card expectations, which already derive it internally.
  void soPlasmid;
  return expected;
};
