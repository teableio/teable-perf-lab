const assertUniqueCaseIds = (caseIds) => {
  if (!Array.isArray(caseIds)) {
    throw new Error("caseIds must be an array.");
  }
  if (new Set(caseIds).size !== caseIds.length) {
    throw new Error("caseIds must not include duplicate case ids.");
  }
};

export const resolveExecutionBundleMembership = ({
  caseIds,
  hybridCaseIds = [],
  affinities = [],
}) => {
  assertUniqueCaseIds(caseIds);
  const selected = new Set(caseIds);
  const hybrid = new Set(hybridCaseIds);
  const membership = new Map();
  const affinityIds = new Set();

  for (const affinity of affinities) {
    if (typeof affinity.id !== "string" || affinity.id.trim().length === 0) {
      throw new Error("Fixture affinity id must be a non-empty string.");
    }
    if (affinityIds.has(affinity.id)) {
      throw new Error(`Duplicate fixture affinity id: ${affinity.id}`);
    }
    affinityIds.add(affinity.id);
    const selectedCaseIds = affinity.caseIds.filter((caseId) =>
      selected.has(caseId),
    );
    const modes = new Set(
      selectedCaseIds.map((caseId) => (hybrid.has(caseId) ? "hybrid" : "sync")),
    );
    if (modes.size > 1) {
      throw new Error(
        `Fixture affinity ${affinity.id} crosses V2 sync and hybrid pools`,
      );
    }
    for (const caseId of selectedCaseIds) {
      const previous = membership.get(caseId);
      if (previous) {
        throw new Error(
          `Case ${caseId} belongs to multiple fixture affinities: ${previous}, ${affinity.id}`,
        );
      }
      membership.set(caseId, affinity.id);
    }
  }
  return membership;
};

export const buildExecutionBundles = ({
  caseIds,
  hybridCaseIds = [],
  affinities = [],
}) => {
  const membership = resolveExecutionBundleMembership({
    caseIds,
    hybridCaseIds,
    affinities,
  });
  const bundles = new Map();
  caseIds.forEach((caseId, firstIndex) => {
    const id = membership.get(caseId) ?? `case:${caseId}`;
    const bundle = bundles.get(id) ?? {
      id,
      caseIds: [],
      firstIndex,
    };
    bundle.caseIds.push(caseId);
    bundles.set(id, bundle);
  });
  return [...bundles.values()];
};
