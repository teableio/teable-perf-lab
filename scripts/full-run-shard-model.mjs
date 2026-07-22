// Full-run sharding has two competing goals:
//
// 1. keep cases that resolve to the same physical seed fixture in one shard;
// 2. keep the parallel seed and execution pools close in estimated cost.
//
// The legacy affinity list below is intentionally explicit. It was verified
// against seedHash values emitted by full-run artifacts, so it describes
// physical fixture reuse rather than merely grouping similar names. New shared
// fixture families declare seedAffinity in their case contract instead. The
// planner merges both sources and rejects unknown, duplicated,
// sync/hybrid-crossing, or post-plan split affinities.
export const FULL_RUN_FIXTURE_AFFINITIES = [
  {
    id: "record-read/10k-50fields",
    caseIds: [
      "record-read/10k-50fields-10x1k-pages",
      "record-read/10k-50fields-filter-formula-greater-half",
      "record-read/10k-50fields-filter-formula-range-middle",
      "record-read/10k-50fields-filter-group-sort-formula",
      "record-read/10k-50fields-filter-lookup-not-empty",
      "record-read/10k-50fields-filter-number-greater-half",
      "record-read/10k-50fields-filter-number-range-middle-half",
      "record-read/10k-50fields-filter-number-sort-descending",
      "record-read/10k-50fields-filter-sort-formula-selective",
      "record-read/10k-50fields-filter-sort-groupby-overhead",
      "record-read/10k-50fields-filter-sort-groupby-selective",
      "record-read/10k-50fields-filter-text-not-empty",
      "record-read/10k-50fields-group-number-low-cardinality",
      "record-read/10k-50fields-group-stored-sort-formula",
      "record-read/10k-50fields-group-stored-sort-lookup",
      "record-read/10k-50fields-group-three-levels",
      "record-read/10k-50fields-search-lookup-visible-row",
      "record-read/10k-50fields-search-title-visible-rows",
      "record-read/10k-50fields-sort-formula-descending",
      "record-read/10k-50fields-sort-lookup-ascending",
      "record-read/10k-50fields-sort-text-ascending",
      "record-read/10k-50fields-sort-three-fields",
    ],
  },
  {
    id: "conditional-query/fanout10-host10k",
    caseIds: [
      "lookup/conditional-group-active-text-10k",
      "lookup/conditional-group-number-top3-10k",
      "lookup/conditional-group-text-fanout10-10k",
      "lookup/conditional-group-text-update-1k-fanout10-10k",
      "rollup/conditional-group-active-max-10k",
      "rollup/conditional-group-active-sum-fanout10-10k",
      "rollup/conditional-group-active-sum-update-1k-fanout10-10k",
      "rollup/conditional-group-average-fanout10-10k",
      "rollup/conditional-group-countall-fanout10-10k",
      "rollup/conditional-group-sum-fanout10-10k",
      "rollup/conditional-group-text-top3-10k",
    ],
  },
  {
    id: "field-create/scalar-title-only-10k",
    caseIds: [
      "field-create/10k-create-1-single-line-text-field",
      "field-create/10k-create-10-checkbox-fields",
      "field-create/10k-create-10-date-fields",
      "field-create/10k-create-10-long-text-fields",
      "field-create/10k-create-10-multiple-select-fields",
      "field-create/10k-create-10-number-fields",
      "field-create/10k-create-10-rating-fields",
      "field-create/10k-create-10-single-line-text-fields",
      "field-create/10k-create-10-single-select-fields",
      "field-create/10k-create-20-single-line-text-fields",
    ],
  },
  {
    id: "record-create/mixed-1k-20fields",
    caseIds: [
      "record-create/1k-checkbox-fields-bulk-create",
      "record-create/1k-date-fields-bulk-create",
      "record-create/1k-long-text-fields-bulk-create",
      "record-create/1k-multiple-select-fields-bulk-create",
      "record-create/1k-number-fields-bulk-create",
      "record-create/1k-rating-field-bulk-create",
      "record-create/1k-single-line-text-fields-bulk-create",
      "record-create/1k-single-select-fields-bulk-create",
      "record-create/1k-wide-table-title-only-bulk-create",
      "record-create/mixed-1k-20fields-bulk-create",
    ],
  },
  {
    id: "record-update/mixed-1k-20fields",
    caseIds: [
      "record-update/1k-checkbox-fields-bulk-update",
      "record-update/1k-date-fields-bulk-update",
      "record-update/1k-long-text-fields-bulk-update",
      "record-update/1k-multiple-select-fields-bulk-update",
      "record-update/1k-number-fields-bulk-update",
      "record-update/1k-rating-field-bulk-update",
      "record-update/1k-single-line-text-fields-bulk-update",
      "record-update/1k-single-select-fields-bulk-update",
      "record-update/1k-wide-table-title-only-bulk-update",
      "record-update/mixed-1k-20fields-bulk-update",
    ],
  },
  {
    id: "conditional-query/fanout100-host10k",
    caseIds: [
      "lookup/conditional-group-active-flip-1k-fanout100-10k",
      "lookup/conditional-group-active-text-fanout100-10k",
      "lookup/conditional-group-number-top3-fanout100-10k",
      "lookup/conditional-group-text-fanout100-10k",
      "lookup/conditional-group-text-update-1k-fanout100-10k",
      "lookup/conditional-group-text-update-1k-fanout100-limit10-10k",
      "lookup/conditional-group-text-update-1k-fanout100-limit50-10k",
      "rollup/conditional-group-active-sum-fanout100-10k",
      "rollup/conditional-group-active-sum-update-1k-fanout100-10k",
    ],
  },
  {
    id: "conditional-query/fanout50-host10k",
    caseIds: [
      "lookup/conditional-group-active-text-fanout50-10k",
      "lookup/conditional-group-number-top3-fanout50-10k",
      "lookup/conditional-group-text-fanout50-10k",
      "lookup/conditional-group-text-update-1k-fanout50-10k",
      "rollup/conditional-group-active-sum-fanout50-10k",
      "rollup/conditional-group-active-sum-update-1k-fanout50-10k",
    ],
  },
  {
    id: "conditional-query/fanout100-host30k",
    caseIds: [
      "lookup/conditional-group-active-flip-1k-fanout100-30k",
      "lookup/conditional-group-text-update-1k-fanout100-30k",
      "rollup/conditional-group-active-sum-update-1k-fanout100-30k",
    ],
  },
  {
    id: "conditional-query/fanout100-host20k",
    caseIds: [
      "lookup/conditional-group-text-update-1k-fanout100-20k",
      "rollup/conditional-group-active-sum-update-1k-fanout100-20k",
    ],
  },
  {
    id: "conditional-computed/10k",
    caseIds: [
      "lookup/conditional-10k",
      "lookup/v2-only-conditional-dirty-host-create-100-10k",
      "rollup/conditional-10k",
    ],
  },
  {
    id: "lookup-search-index/10k-20fields",
    caseIds: [
      "search/search-index-off-10k-20search-fields",
      "search/search-index-on-10k-20search-fields",
    ],
  },
  {
    id: "lookup-search-index/50k-20fields",
    caseIds: [
      "search/search-index-off-50k-20search-fields",
      "search/search-index-on-50k-20search-fields",
    ],
  },
];

// Stable slots capture the accepted eight-shard assignment before compatible
// cache restore was introduced. They are a secondary constraint: the planner
// keeps these affinity bundles in place while the modeled max load stays within
// tolerance, and reports any move that is required to protect the critical path.
export const FULL_RUN_HISTORICAL_SHARD_SLOTS = {
  "record-read/10k-50fields": 4,
  "conditional-query/fanout10-host10k": 1,
  "field-create/scalar-title-only-10k": 7,
  "record-create/mixed-1k-20fields": 5,
  "record-update/mixed-1k-20fields": 5,
  "conditional-query/fanout100-host10k": 6,
  "conditional-query/fanout50-host10k": 2,
  "conditional-query/fanout100-host30k": 8,
  "conditional-query/fanout100-host20k": 2,
  "conditional-computed/10k": 6,
  "lookup-search-index/100k-20fields": 8,
  "record-read/100k-50fields": 7,
};

// Full regression keeps the scale-up sibling for low-signal workloads while
// preserving the smaller case in the registry for targeted/manual runs. This
// first batch was calibrated from full run 29912515531: the omitted case had a
// slower-engine primary metric below 500 ms and the replacement exercises the
// same workload shape at a larger scale.
export const FULL_RUN_SCALE_REPLACEMENTS = {
  "duplicate-table/10k-20f": "duplicate-table/50k-20f",
  "field-delete/10k-delete-active-field":
    "field-delete/50k-delete-active-field",
  "field-delete/10k-delete-amount-field":
    "field-delete/50k-delete-amount-field",
  "field-delete/10k-delete-description-field":
    "field-delete/50k-delete-description-field",
  "field-delete/10k-delete-owner-text-field":
    "field-delete/50k-delete-owner-text-field",
  "field-delete/10k-delete-score-field": "field-delete/50k-delete-score-field",
  "field-delete/10k-delete-start-date-field":
    "field-delete/50k-delete-start-date-field",
  "field-delete/10k-delete-status-field":
    "field-delete/50k-delete-status-field",
  "field-delete/10k-delete-tags-field": "field-delete/50k-delete-tags-field",
  "form-submit/sequential-50-checkbox-10fields":
    "form-submit/sequential-500-checkbox-10fields",
  "form-submit/sequential-50-date-10fields":
    "form-submit/sequential-500-date-10fields",
  "form-submit/sequential-50-long-text-10fields":
    "form-submit/sequential-500-long-text-10fields",
  "form-submit/sequential-50-multiple-select-10fields":
    "form-submit/sequential-500-multiple-select-10fields",
  "form-submit/sequential-50-number-10fields":
    "form-submit/sequential-500-number-10fields",
  "form-submit/sequential-50-primary-only":
    "form-submit/sequential-500-primary-only",
  "form-submit/sequential-50-rating-10fields":
    "form-submit/sequential-500-rating-10fields",
  "form-submit/sequential-50-single-line-text-10fields":
    "form-submit/sequential-500-single-line-text-10fields",
  "form-submit/sequential-50-single-line-text-20fields":
    "form-submit/sequential-500-single-line-text-20fields",
  "form-submit/sequential-50-single-select-10fields":
    "form-submit/sequential-500-single-select-10fields",
  "lookup/customer-create-order-only-4k-depth5":
    "lookup/customer-create-order-only-20k-depth5",
  "lookup/customer-update-user-control-field-create-order-4k-depth5":
    "lookup/customer-update-user-control-field-create-order-20k-depth5",
  "record-create/1k-checkbox-fields-bulk-create":
    "record-create/5k-checkbox-fields-bulk-create",
  "record-create/1k-date-fields-bulk-create":
    "record-create/5k-date-fields-bulk-create",
  "record-create/1k-long-text-fields-bulk-create":
    "record-create/5k-long-text-fields-bulk-create",
  "record-create/1k-multiple-select-fields-bulk-create":
    "record-create/5k-multiple-select-fields-bulk-create",
  "record-create/1k-number-fields-bulk-create":
    "record-create/5k-number-fields-bulk-create",
  "record-create/1k-primary-text-only-bulk-create":
    "record-create/5k-primary-text-only-bulk-create",
  "record-create/1k-rating-field-bulk-create":
    "record-create/5k-rating-field-bulk-create",
  "record-create/1k-single-select-fields-bulk-create":
    "record-create/5k-single-select-fields-bulk-create",
  "record-create/1k-wide-table-title-only-bulk-create":
    "record-create/5k-wide-table-title-only-bulk-create",
  "record-delete/delete-1k": "record-delete/delete-5k",
  "record-delete/delete-stream-1k": "record-delete/delete-stream-10k",
  "record-delete/link-trash-1k": "record-delete/link-trash-5k",
  "record-duplicate/single-50-checkbox-10fields":
    "record-duplicate/single-500-checkbox-10fields",
  "record-duplicate/single-50-date-10fields":
    "record-duplicate/single-500-date-10fields",
  "record-duplicate/single-50-long-text-10fields":
    "record-duplicate/single-500-long-text-10fields",
  "record-duplicate/single-50-mixed-20fields":
    "record-duplicate/single-500-mixed-20fields",
  "record-duplicate/single-50-multiple-select-10fields":
    "record-duplicate/single-500-multiple-select-10fields",
  "record-duplicate/single-50-number-10fields":
    "record-duplicate/single-500-number-10fields",
  "record-duplicate/single-50-primary-only":
    "record-duplicate/single-500-primary-only",
  "record-duplicate/single-50-rating-10fields":
    "record-duplicate/single-500-rating-10fields",
  "record-duplicate/single-50-single-line-text-10fields":
    "record-duplicate/single-500-single-line-text-10fields",
  "record-duplicate/single-50-single-select-10fields":
    "record-duplicate/single-500-single-select-10fields",
  "record-paste/1k-primary-only": "record-paste/10k-primary-only",
  "record-read/10k-50fields-filter-number-greater-half":
    "record-read/100k-50fields-filter-number-greater-half",
  "record-read/10k-50fields-filter-number-range-middle-half":
    "record-read/100k-50fields-filter-number-range-middle-half",
  "record-read/10k-50fields-filter-number-sort-descending":
    "record-read/100k-50fields-filter-number-sort-descending",
  "record-read/10k-50fields-filter-sort-groupby-selective":
    "record-read/50k-50fields-filter-sort-groupby-selective",
  "record-read/10k-50fields-filter-text-not-empty":
    "record-read/50k-50fields-filter-text-not-empty",
  "record-read/10k-50fields-group-number-low-cardinality":
    "record-read/50k-50fields-group-number-low-cardinality",
  "record-read/10k-50fields-search-title-visible-rows":
    "record-read/50k-50fields-search-title-visible-rows",
  "record-read/10k-50fields-sort-text-ascending":
    "record-read/50k-50fields-sort-text-ascending",
  "record-read/10k-50fields-sort-three-fields":
    "record-read/50k-50fields-sort-three-fields",
  "record-read/50k-50fields-filter-number-greater-half":
    "record-read/100k-50fields-filter-number-greater-half",
  "record-read/50k-50fields-filter-number-range-middle-half":
    "record-read/100k-50fields-filter-number-range-middle-half",
  "record-read/50k-50fields-filter-number-sort-descending":
    "record-read/100k-50fields-filter-number-sort-descending",
  "record-redo/delete-1k": "record-redo/delete-10k",
  "record-update/1k-checkbox-fields-bulk-update":
    "record-update/5k-checkbox-fields-bulk-update",
  "record-update/1k-long-text-fields-bulk-update":
    "record-update/5k-long-text-fields-bulk-update",
  "record-update/1k-multiple-select-fields-bulk-update":
    "record-update/5k-multiple-select-fields-bulk-update",
  "record-update/1k-primary-text-only-bulk-update":
    "record-update/5k-primary-text-only-bulk-update",
  "record-update/1k-single-select-fields-bulk-update":
    "record-update/5k-single-select-fields-bulk-update",
  "record-update/1k-wide-table-title-only-bulk-update":
    "record-update/5k-wide-table-title-only-bulk-update",
  "search/search-index-off-10k-20search-fields":
    "search/search-index-off-100k-20search-fields",
  "search/search-index-off-50k-20search-fields":
    "search/search-index-off-100k-20search-fields",
  "search/search-index-on-10k-20search-fields":
    "search/search-index-on-100k-20search-fields",
  "search/search-index-on-50k-20search-fields":
    "search/search-index-on-100k-20search-fields",
  "table-create/1x-1f-1k-primary-only": "table-create/1x-1f-5k-primary-only",
  "table-delete/10k-20f": "table-delete/50k-20f",
  "table-restore/10k-20f": "table-restore/50k-20f",
  "table-restore/10k-20f-link-1k": "table-restore/50k-20f-link-1k",
};

export const validateFullRunScaleReplacements = ({
  allCaseIds,
  replacements = FULL_RUN_SCALE_REPLACEMENTS,
}) => {
  const registeredCaseIds = new Set(allCaseIds);
  const omittedCaseIds = new Set(Object.keys(replacements));
  const issues = [];

  for (const [omittedCaseId, replacementCaseId] of Object.entries(
    replacements,
  )) {
    if (!registeredCaseIds.has(omittedCaseId)) {
      issues.push(
        `Full-run scale policy references unknown case ${omittedCaseId}`,
      );
    }
    if (!registeredCaseIds.has(replacementCaseId)) {
      issues.push(
        `Full-run scale policy replacement is unknown: ${omittedCaseId} -> ${replacementCaseId}`,
      );
    }
    if (omittedCaseId === replacementCaseId) {
      issues.push(
        `Full-run scale policy replaces ${omittedCaseId} with itself`,
      );
    }
    if (omittedCaseIds.has(replacementCaseId)) {
      issues.push(
        `Full-run scale policy replacement is also omitted: ${omittedCaseId} -> ${replacementCaseId}`,
      );
    }
  }

  return issues;
};

export const resolveFullRunCaseIds = ({
  allCaseIds,
  replacements = FULL_RUN_SCALE_REPLACEMENTS,
}) => {
  const issues = validateFullRunScaleReplacements({ allCaseIds, replacements });
  if (issues.length > 0) {
    throw new Error(issues.join("\n"));
  }

  const omittedCaseIds = new Set(Object.keys(replacements));
  return allCaseIds.filter((caseId) => !omittedCaseIds.has(caseId));
};

// Keep full-run wall time close to the fixed report stage without creating an
// unbounded matrix. It grows automatically as cases are added, up to the point
// where the 2026-07 calibration showed no material gain from more parallel
// jobs.
export const FULL_RUN_TARGET_CASES_PER_SHARD = 40;
export const FULL_RUN_MAX_SHARD_COUNT = 8;

// A case has execution/trace overhead even when seed mode is effectively free.
// Adding this baseline keeps seed-heavy LPT packing from producing pathological
// 3-case and 80-case shards that would move the long tail into execute mode.
export const FULL_RUN_CASE_OVERHEAD_WEIGHT_MS = 10_000;
export const FULL_RUN_DEFAULT_SEED_WEIGHT_MS = 1_000;

// Cold-seed caseMs calibration from Actions run 29738811090. Only material
// outliers are pinned; cheap/unseen cases use the default above. Shared fixture
// siblings remain one bundle, so the weight is stable even if the case that
// first creates the physical table changes with catalog order.
export const FULL_RUN_SEED_WEIGHT_MS_BY_CASE_ID = {
  "record-read/50k-50fields-50x1k-pages": 440_282,
  "search/search-index-off-50k-20search-fields": 368_802,
  "table-delete/10k-20f-link-detach": 105_680,
  "record-read/10k-50fields-10x1k-pages": 79_696,
  "lookup/conditional-group-text-fanout100-10k": 72_230,
  "lookup/conditional-group-text-update-1k-fanout100-30k": 67_153,
  "lookup/conditional-group-text-update-1k-fanout100-20k": 64_256,
  "search/search-index-off-10k-20search-fields": 55_569,
  "record-delete/delete-stream-30k": 47_959,
  "field-convert/10k-link-to-text": 47_910,
  "table-delete/30k-20f-link-detach": 41_012,
  "lookup/dual-link-computed-first-link-4k": 37_938,
  "formula/50k-calc": 36_517,
  "field-duplicate/10k-duplicate-rollup-field": 36_219,
  "lookup/dual-link-computed-first-link-1of4k-get-records": 34_663,
  "lookup/dual-link-computed-repoint-2k": 32_985,
  "lookup/conditional-group-text-fanout50-10k": 31_161,
  "field-duplicate/10k-duplicate-many-many-link-field": 30_649,
  "lookup/customer-update-user-update-order-4k-depth5": 28_656,
  "lookup/customer-update-user-first-name-only-create-order-4k-depth5": 28_521,
  "duplicate-table/10k-20f-selflink": 28_061,
  "duplicate-table/10k-25f-5formula": 26_434,
  "lookup/dual-link-computed-first-link-1of4k-get-record": 25_039,
  "lookup/foreign-first-name-update-1of40-fanout100-4k": 25_005,
  "field-convert/formula-expression-update-4k-depth5-cascade": 24_785,
  "field-restore/10k-status-field": 24_705,
  "lookup/conditional-group-text-fanout10-10k": 24_598,
  "table-restore/10k-20f": 24_593,
  "record-delete/delete-stream-10k": 24_448,
  "field-duplicate/conditional-lookup-10k": 24_260,
  "field-duplicate/10k-duplicate-conditional-rollup-field": 22_140,
  "lookup/customer-create-user-create-order-4k-depth5": 21_181,
  "field-convert/10k-text-to-link": 20_656,
  "lookup/customer-update-other-user-create-order-4k-depth5": 20_606,
  "field-convert/10k-text-to-date-mixed": 20_429,
};

export const resolveFullRunShardCount = (
  caseCount,
  {
    targetCasesPerShard = FULL_RUN_TARGET_CASES_PER_SHARD,
    maxShardCount = FULL_RUN_MAX_SHARD_COUNT,
  } = {},
) => {
  if (!Number.isInteger(caseCount) || caseCount < 1) {
    throw new Error("caseCount must be a positive integer.");
  }
  assertPositiveShardCount(targetCasesPerShard);
  assertPositiveShardCount(maxShardCount);
  return Math.min(maxShardCount, Math.ceil(caseCount / targetCasesPerShard));
};

export const fullRunCaseWeightMs = (caseId) =>
  fullRunCaseSeedWeightMs(caseId) + FULL_RUN_CASE_OVERHEAD_WEIGHT_MS;

export const fullRunCaseSeedWeightMs = (caseId) =>
  FULL_RUN_SEED_WEIGHT_MS_BY_CASE_ID[caseId] ?? FULL_RUN_DEFAULT_SEED_WEIGHT_MS;

const assertPositiveShardCount = (shardCount) => {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("shardCount must be a positive integer.");
  }
};

const indexAffinitiesById = (affinities) => {
  const result = new Map();
  for (const affinity of affinities) {
    if (result.has(affinity.id)) {
      throw new Error(`Duplicate fixture affinity id: ${affinity.id}`);
    }
    result.set(affinity.id, affinity);
  }
  return result;
};

const affinityByCaseId = (affinities) => {
  const result = new Map();
  for (const affinity of indexAffinitiesById(affinities).values()) {
    for (const caseId of affinity.caseIds) {
      const previous = result.get(caseId);
      if (previous) {
        throw new Error(
          `Case ${caseId} belongs to multiple fixture affinities: ${previous}, ${affinity.id}`,
        );
      }
      result.set(caseId, affinity.id);
    }
  }
  return result;
};

const assertNonEmptyText = (value, label) => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
};

export const resolveFixtureAffinities = ({
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
  seedAffinityDeclarations = [],
}) => {
  const byAffinityId = new Map(
    [...indexAffinitiesById(affinities)].map(([affinityId, affinity]) => [
      affinityId,
      { ...affinity, caseIds: [...affinity.caseIds] },
    ]),
  );

  const declaredCaseIds = new Set();
  for (const { caseId, affinityId } of seedAffinityDeclarations) {
    assertNonEmptyText(caseId, "Seed affinity declaration caseId");
    assertNonEmptyText(affinityId, "Seed affinity declaration affinityId");
    if (declaredCaseIds.has(caseId)) {
      throw new Error(`Duplicate seed affinity declaration for case ${caseId}`);
    }
    declaredCaseIds.add(caseId);
    const affinity = byAffinityId.get(affinityId) ?? {
      id: affinityId,
      caseIds: [],
    };
    affinity.caseIds.push(caseId);
    byAffinityId.set(affinityId, affinity);
  }

  return [...byAffinityId.values()];
};

export const validateFixtureAffinities = ({
  allCaseIds,
  hybridCaseIds = [],
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
}) => {
  const registered = new Set(allCaseIds);
  const hybrid = new Set(hybridCaseIds);
  const issues = [];
  const membership = affinityByCaseId(affinities);

  for (const [caseId, affinityId] of membership) {
    if (!registered.has(caseId)) {
      issues.push(
        `Fixture affinity ${affinityId} references unknown case ${caseId}`,
      );
    }
  }

  for (const affinity of affinities) {
    const selected = affinity.caseIds.filter((caseId) =>
      registered.has(caseId),
    );
    const modes = new Set(
      selected.map((caseId) => (hybrid.has(caseId) ? "hybrid" : "sync")),
    );
    if (modes.size > 1) {
      issues.push(
        `Fixture affinity ${affinity.id} crosses V2 sync and hybrid pools`,
      );
    }
  }

  return issues;
};

export const validateShardAffinityAssignments = ({
  caseShards,
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
}) => {
  const shardByCaseId = new Map();
  caseShards.forEach((caseIds, shardIndex) =>
    caseIds.forEach((caseId) => shardByCaseId.set(caseId, shardIndex)),
  );
  const issues = [];

  for (const affinity of affinities) {
    const casesByShard = new Map();
    for (const caseId of affinity.caseIds) {
      const shardIndex = shardByCaseId.get(caseId);
      if (shardIndex == null) {
        continue;
      }
      const caseIds = casesByShard.get(shardIndex) ?? [];
      caseIds.push(caseId);
      casesByShard.set(shardIndex, caseIds);
    }
    if (casesByShard.size < 2) {
      continue;
    }
    const locations = [...casesByShard]
      .sort(([left], [right]) => left - right)
      .map(
        ([shardIndex, caseIds]) =>
          `shard-${shardIndex + 1}=[${caseIds.join(", ")}]`,
      );
    issues.push(
      `Fixture affinity ${affinity.id} spans seed shards: ${locations.join(", ")}`,
    );
  }

  return issues;
};

const buildBundles = (caseIds, affinities, caseWeight, caseCacheImpact) => {
  const membership = affinityByCaseId(affinities);
  const bundles = new Map();
  caseIds.forEach((caseId, index) => {
    const key = membership.get(caseId) ?? `case:${caseId}`;
    const bundle = bundles.get(key) ?? {
      id: key,
      caseIds: [],
      firstIndex: index,
      weight: 0,
      cacheImpactMs: 0,
    };
    bundle.caseIds.push(caseId);
    bundle.weight += caseWeight(caseId);
    bundle.cacheImpactMs += caseCacheImpact(caseId);
    bundles.set(key, bundle);
  });
  return [...bundles.values()].sort(
    (left, right) =>
      right.weight - left.weight ||
      right.caseIds.length - left.caseIds.length ||
      left.firstIndex - right.firstIndex,
  );
};

const placeBundlesGreedily = ({ bundles, shardCount }) => {
  const bundleShards = Array.from({ length: shardCount }, () => []);
  const loads = Array.from({ length: shardCount }, () => 0);
  for (const bundle of bundles) {
    const target = loads.indexOf(Math.min(...loads));
    bundleShards[target].push(bundle);
    loads[target] += bundle.weight;
  }
  return { bundleShards, loads };
};

const maxLoad = (loads) => Math.max(...loads, 0);

const descendingLoadVector = (loads) =>
  loads.slice().sort((left, right) => right - left);

const compareLoadVectors = (left, right) => {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

const MAX_STABLE_SEARCH_STATES = 50_000;

const visitCombinations = ({ items, size, state, visit }) => {
  const selected = [];
  const walk = (start) => {
    if (state.evaluated >= MAX_STABLE_SEARCH_STATES) {
      return;
    }
    if (selected.length === size) {
      state.evaluated += 1;
      visit(selected);
      return;
    }
    const remaining = size - selected.length;
    for (let index = start; index <= items.length - remaining; index += 1) {
      selected.push(items[index]);
      walk(index + 1);
      selected.pop();
      if (state.evaluated >= MAX_STABLE_SEARCH_STATES) {
        return;
      }
    }
  };
  walk(0);
};

export const planCaseIdsByFixtureAffinity = ({
  caseIds,
  shardCount,
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
  caseWeight = fullRunCaseWeightMs,
  caseCacheImpact = fullRunCaseSeedWeightMs,
  preferredSlotByAffinity = {},
  maxStableLoadRatio = 1.1,
}) => {
  assertPositiveShardCount(shardCount);
  if (!Number.isFinite(maxStableLoadRatio) || maxStableLoadRatio < 1) {
    throw new Error("maxStableLoadRatio must be at least 1.");
  }
  if (caseIds.length === 0) {
    return {
      caseShards: Array.from({ length: shardCount }, () => []),
      shardLoads: Array.from({ length: shardCount }, () => 0),
      movedAffinities: [],
      preservedAffinityCount: 0,
    };
  }
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("caseIds must not include duplicate case ids.");
  }

  const bundles = buildBundles(
    caseIds,
    affinities,
    caseWeight,
    caseCacheImpact,
  );
  const greedy = placeBundlesGreedily({ bundles, shardCount });
  const declaredPreferredBundles = bundles.flatMap((bundle) => {
    const preferredSlot = preferredSlotByAffinity[bundle.id];
    if (preferredSlot == null) {
      return [];
    }
    if (!Number.isInteger(preferredSlot) || preferredSlot < 1) {
      throw new Error(
        `Preferred stable slot for ${bundle.id} must be a positive integer.`,
      );
    }
    return [{ bundle, preferredSlot }];
  });
  const inRangePreferredBundles = declaredPreferredBundles.filter(
    ({ preferredSlot }) => preferredSlot <= shardCount,
  );

  const largestBundleWeight = Math.max(
    ...bundles.map((bundle) => bundle.weight),
    0,
  );
  const allowedMaxLoad = Math.max(
    largestBundleWeight,
    maxLoad(greedy.loads) * maxStableLoadRatio,
  );
  const buildStableCandidate = (unlockedAffinityIds) => {
    const bundleShards = Array.from({ length: shardCount }, () => []);
    const loads = Array.from({ length: shardCount }, () => 0);
    const lockedBundles = new Set();

    for (const { bundle, preferredSlot } of inRangePreferredBundles) {
      if (unlockedAffinityIds.has(bundle.id)) {
        continue;
      }
      const target = preferredSlot - 1;
      bundleShards[target].push(bundle);
      loads[target] += bundle.weight;
      lockedBundles.add(bundle);
    }

    for (const bundle of bundles) {
      if (lockedBundles.has(bundle)) {
        continue;
      }
      const target = loads.indexOf(Math.min(...loads));
      bundleShards[target].push(bundle);
      loads[target] += bundle.weight;
    }

    if (maxLoad(loads) > allowedMaxLoad) {
      return undefined;
    }

    const movedAffinities = declaredPreferredBundles.flatMap(
      ({ bundle, preferredSlot }) => {
        const actualSlot =
          bundleShards.findIndex((items) => items.includes(bundle)) + 1;
        if (actualSlot === preferredSlot) {
          return [];
        }
        return [
          {
            affinityId: bundle.id,
            fromStableSlot: preferredSlot,
            toStableSlot: actualSlot,
            caseIds: bundle.caseIds.slice(),
            estimatedCacheImpactMs: bundle.cacheImpactMs,
            reason:
              preferredSlot > shardCount
                ? "stable slot is unavailable at this shard count"
                : "stable slot exceeded the load tolerance",
          },
        ];
      },
    );
    const cacheImpactMs = movedAffinities.reduce(
      (total, movement) => total + movement.estimatedCacheImpactMs,
      0,
    );

    return {
      bundleShards,
      loads,
      movedAffinities,
      unlockedCount: unlockedAffinityIds.size,
      cacheImpactMs,
      loadVector: descendingLoadVector(loads),
      movementKey: movedAffinities
        .map(({ affinityId }) => affinityId)
        .sort()
        .join("\n"),
      assignmentKey: bundleShards
        .map((items) => items.map(({ id }) => id).join(","))
        .join("|"),
    };
  };

  const compareStableCandidates = (left, right) =>
    left.movedAffinities.length - right.movedAffinities.length ||
    left.cacheImpactMs - right.cacheImpactMs ||
    compareLoadVectors(left.loadVector, right.loadVector) ||
    left.unlockedCount - right.unlockedCount ||
    left.movementKey.localeCompare(right.movementKey) ||
    left.assignmentKey.localeCompare(right.assignmentKey);

  let selectedCandidate;
  const selectableAffinityIds = inRangePreferredBundles.map(
    ({ bundle }) => bundle.id,
  );
  const searchState = { evaluated: 0 };
  for (
    let unlockCount = 0;
    unlockCount <= selectableAffinityIds.length;
    unlockCount += 1
  ) {
    visitCombinations({
      items: selectableAffinityIds,
      size: unlockCount,
      state: searchState,
      visit: (unlockedIds) => {
        const candidate = buildStableCandidate(new Set(unlockedIds));
        if (
          candidate &&
          (!selectedCandidate ||
            compareStableCandidates(candidate, selectedCandidate) < 0)
        ) {
          selectedCandidate = candidate;
        }
      },
    });
    if (searchState.evaluated >= MAX_STABLE_SEARCH_STATES) {
      break;
    }
  }
  const allUnlockedCandidate = buildStableCandidate(
    new Set(selectableAffinityIds),
  );
  if (
    allUnlockedCandidate &&
    (!selectedCandidate ||
      compareStableCandidates(allUnlockedCandidate, selectedCandidate) < 0)
  ) {
    selectedCandidate = allUnlockedCandidate;
  }
  if (!selectedCandidate) {
    throw new Error(
      `Stable-slot planner could not satisfy load tolerance: allowed=${allowedMaxLoad}`,
    );
  }

  const { bundleShards, loads, movedAffinities } = selectedCandidate;

  const caseOrder = new Map(caseIds.map((caseId, index) => [caseId, index]));
  const caseShards = bundleShards.map((bundlesInShard) =>
    bundlesInShard
      .flatMap((bundle) => bundle.caseIds)
      .sort((left, right) => caseOrder.get(left) - caseOrder.get(right)),
  );
  return {
    caseShards,
    shardLoads: loads,
    movedAffinities,
    preservedAffinityCount:
      declaredPreferredBundles.length - movedAffinities.length,
  };
};

export const shardCaseIdsByFixtureAffinity = ({
  caseIds,
  shardCount,
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
  caseWeight = fullRunCaseWeightMs,
  caseCacheImpact = fullRunCaseSeedWeightMs,
  preferredSlotByAffinity,
  maxStableLoadRatio,
}) =>
  planCaseIdsByFixtureAffinity({
    caseIds,
    shardCount,
    affinities,
    caseWeight,
    caseCacheImpact,
    preferredSlotByAffinity,
    maxStableLoadRatio,
  }).caseShards;

export const buildFullRunCaseShardPlan = ({
  allCaseIds,
  hybridCaseIds,
  shardCount,
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
  caseWeight = fullRunCaseWeightMs,
  caseCacheImpact = fullRunCaseSeedWeightMs,
  preferredSlotByAffinity = FULL_RUN_HISTORICAL_SHARD_SLOTS,
  maxStableLoadRatio = 1.1,
}) => {
  assertPositiveShardCount(shardCount);
  if (allCaseIds.length === 0) {
    throw new Error("Cannot shard an empty case list.");
  }

  const hybrid = new Set(hybridCaseIds);
  const syncCaseIds = allCaseIds.filter((caseId) => !hybrid.has(caseId));
  const selectedHybridCaseIds = allCaseIds.filter((caseId) =>
    hybrid.has(caseId),
  );
  const syncPlan = planCaseIdsByFixtureAffinity({
    caseIds: syncCaseIds,
    shardCount,
    affinities,
    caseWeight,
    caseCacheImpact,
    preferredSlotByAffinity,
    maxStableLoadRatio,
  });
  const hybridPlan = planCaseIdsByFixtureAffinity({
    caseIds: selectedHybridCaseIds,
    shardCount,
    affinities,
    caseWeight,
    caseCacheImpact,
    preferredSlotByAffinity,
    maxStableLoadRatio,
  });

  const caseOrder = new Map(allCaseIds.map((caseId, index) => [caseId, index]));
  const caseShards = syncPlan.caseShards.map((syncCaseIdsInSlot, index) =>
    [...syncCaseIdsInSlot, ...hybridPlan.caseShards[index]].sort(
      (left, right) => caseOrder.get(left) - caseOrder.get(right),
    ),
  );
  return {
    caseShards,
    shardLoads: caseShards.map((caseIds) =>
      caseIds.reduce((total, caseId) => total + caseWeight(caseId), 0),
    ),
    movedAffinities: [
      ...syncPlan.movedAffinities,
      ...hybridPlan.movedAffinities,
    ].sort((left, right) => left.affinityId.localeCompare(right.affinityId)),
    preservedAffinityCount:
      syncPlan.preservedAffinityCount + hybridPlan.preservedAffinityCount,
  };
};

export const buildFullRunCaseShards = (options) =>
  buildFullRunCaseShardPlan(options).caseShards;
