// Full-run sharding has two competing goals:
//
// 1. keep cases that resolve to the same physical seed fixture in one shard;
// 2. keep the four execution pools close in size.
//
// The affinity list below is intentionally explicit. It was verified against
// the seedHash values emitted by full-run artifacts, so it describes physical
// fixture reuse rather than merely grouping cases with similar names. When a
// runner introduces another shared seed identity, add its cases here. The run
// plan check rejects unknown, duplicated, or sync/hybrid-crossing affinities.
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
    caseIds: ["lookup/conditional-10k", "rollup/conditional-10k"],
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

const assertPositiveShardCount = (shardCount) => {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error("shardCount must be a positive integer.");
  }
};

const affinityByCaseId = (affinities) => {
  const result = new Map();
  const affinityIds = new Set();
  for (const affinity of affinities) {
    if (affinityIds.has(affinity.id)) {
      throw new Error(`Duplicate fixture affinity id: ${affinity.id}`);
    }
    affinityIds.add(affinity.id);
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

const buildBundles = (caseIds, affinities) => {
  const membership = affinityByCaseId(affinities);
  const bundles = new Map();
  caseIds.forEach((caseId, index) => {
    const key = membership.get(caseId) ?? `case:${caseId}`;
    const bundle = bundles.get(key) ?? { caseIds: [], firstIndex: index };
    bundle.caseIds.push(caseId);
    bundles.set(key, bundle);
  });
  return [...bundles.values()].sort(
    (left, right) =>
      right.caseIds.length - left.caseIds.length ||
      left.firstIndex - right.firstIndex,
  );
};

export const shardCaseIdsByFixtureAffinity = ({
  caseIds,
  shardCount,
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
}) => {
  assertPositiveShardCount(shardCount);
  if (caseIds.length === 0) {
    return Array.from({ length: shardCount }, () => []);
  }
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("caseIds must not include duplicate case ids.");
  }

  const caseOrder = new Map(caseIds.map((caseId, index) => [caseId, index]));
  const shards = Array.from({ length: shardCount }, () => []);
  const loads = Array.from({ length: shardCount }, () => 0);

  for (const bundle of buildBundles(caseIds, affinities)) {
    const target = loads.indexOf(Math.min(...loads));
    shards[target].push(...bundle.caseIds);
    loads[target] += bundle.caseIds.length;
  }

  return shards.map((shard) =>
    shard
      .slice()
      .sort((left, right) => caseOrder.get(left) - caseOrder.get(right)),
  );
};

export const buildFullRunCaseShards = ({
  allCaseIds,
  hybridCaseIds,
  shardCount,
  affinities = FULL_RUN_FIXTURE_AFFINITIES,
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
  const syncShards = shardCaseIdsByFixtureAffinity({
    caseIds: syncCaseIds,
    shardCount,
    affinities,
  });
  const hybridShards = shardCaseIdsByFixtureAffinity({
    caseIds: selectedHybridCaseIds,
    shardCount,
    affinities,
  });

  // Pair the largest hybrid shard with the smallest sync shard. Both pools stay
  // independently balanced, while their combined seed/V1 shard sizes converge.
  const syncOrder = syncShards
    .map((caseIds, index) => ({ caseIds, index }))
    .sort(
      (left, right) =>
        left.caseIds.length - right.caseIds.length || left.index - right.index,
    );
  const hybridOrder = hybridShards
    .map((caseIds, index) => ({ caseIds, index }))
    .sort(
      (left, right) =>
        right.caseIds.length - left.caseIds.length || left.index - right.index,
    );

  const caseOrder = new Map(allCaseIds.map((caseId, index) => [caseId, index]));
  return syncOrder.map((syncShard, index) =>
    [...syncShard.caseIds, ...hybridOrder[index].caseIds].sort(
      (left, right) => caseOrder.get(left) - caseOrder.get(right),
    ),
  );
};
