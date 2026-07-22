import { createHash } from "node:crypto";

export const SEED_CONTRACT_GENERATION = "seed-contract-v1";

const requireNonEmptyString = (value, label) => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
};

const cacheKeySegment = (value, label) =>
  requireNonEmptyString(value, label).replace(/[^a-zA-Z0-9_.-]+/g, "-");

const requireCommitSha = (value, label) => {
  const normalized = requireNonEmptyString(value, label).toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error(`${label} must be a 40-character commit SHA`);
  }
  return normalized;
};

export const normalizeSeedCacheNamespace = (value = "") => {
  if (typeof value !== "string") {
    throw new Error("seed_cache_namespace must be a string.");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return "";
  }
  if (normalized.length > 40) {
    throw new Error("seed_cache_namespace must be at most 40 characters.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(normalized)) {
    throw new Error(
      "seed_cache_namespace must contain only letters, digits, dots, underscores, and hyphens.",
    );
  }
  return normalized;
};

export const buildCaseSetDigest = (caseIds) => {
  if (!Array.isArray(caseIds) || caseIds.length === 0) {
    throw new Error("caseIds must include at least one case id");
  }
  const normalized = caseIds.map((caseId) =>
    requireNonEmptyString(caseId, "caseIds[]"),
  );
  if (new Set(normalized).size !== normalized.length) {
    throw new Error("caseIds must not include duplicates");
  }
  return createHash("sha256")
    .update(normalized.slice().sort().join("\n"))
    .digest("hex")
    .slice(0, 16);
};

export const buildSeedCacheIdentity = ({
  runnerOs,
  schemaHash,
  seedContractGeneration,
  stableSlot,
  caseSetDigest,
  sourceHash,
  cacheNamespace = "",
}) => {
  const normalizedCacheNamespace = normalizeSeedCacheNamespace(cacheNamespace);
  const compatibleRestorePrefix = [
    "perf-seed-db",
    ...(normalizedCacheNamespace ? [normalizedCacheNamespace] : []),
    cacheKeySegment(runnerOs, "runnerOs"),
    cacheKeySegment(schemaHash, "schemaHash"),
    cacheKeySegment(seedContractGeneration, "seedContractGeneration"),
    cacheKeySegment(stableSlot, "stableSlot"),
  ].join("-");
  const exactKey = [
    compatibleRestorePrefix,
    cacheKeySegment(caseSetDigest, "caseSetDigest"),
    cacheKeySegment(sourceHash, "sourceHash"),
  ].join("-");

  return {
    exactKey,
    compatibleRestorePrefix: `${compatibleRestorePrefix}-`,
  };
};

export const resolveSeedCacheOutcome = ({
  exactKey,
  compatibleRestorePrefix,
  matchedKey,
  dumpPresent,
  dumpRestored,
  fixtureValidation,
}) => {
  requireNonEmptyString(exactKey, "exactKey");
  requireNonEmptyString(compatibleRestorePrefix, "compatibleRestorePrefix");
  if (!Array.isArray(fixtureValidation)) {
    throw new Error("fixtureValidation must be an array");
  }

  if (!matchedKey) {
    return {
      mode: "cache-miss",
      requiresRunnerValidation: true,
      reusedFixtureCount: 0,
      rebuiltFixtureCount: 0,
    };
  }

  if (matchedKey === exactKey) {
    if (!dumpPresent) {
      throw new Error("Exact seed cache hit is missing its database dump");
    }
    return {
      mode: "exact-hit",
      requiresRunnerValidation: false,
      reusedFixtureCount: 0,
      rebuiltFixtureCount: 0,
    };
  }

  if (!matchedKey.startsWith(compatibleRestorePrefix)) {
    throw new Error(
      `Matched seed cache key is outside the compatible prefix: ${matchedKey}`,
    );
  }
  if (!dumpPresent || !dumpRestored) {
    return {
      mode: "compatible-restore-failed",
      requiresRunnerValidation: true,
      reusedFixtureCount: 0,
      rebuiltFixtureCount: fixtureValidation.length,
    };
  }

  const invalidStatuses = fixtureValidation.filter(
    (status) => !["valid", "missing", "stale"].includes(status),
  );
  if (invalidStatuses.length > 0) {
    throw new Error(
      `Unsupported fixture validation status: ${invalidStatuses.join(", ")}`,
    );
  }
  const reusedFixtureCount = fixtureValidation.filter(
    (status) => status === "valid",
  ).length;
  const rebuiltFixtureCount = fixtureValidation.length - reusedFixtureCount;

  return {
    mode:
      rebuiltFixtureCount > 0 ? "compatible-self-healed" : "compatible-restore",
    requiresRunnerValidation: true,
    reusedFixtureCount,
    rebuiltFixtureCount,
  };
};

export const buildSeedCacheStatus = ({
  cacheHit,
  primaryKey,
  matchedKey = "",
  caseSetDigest,
  stableSlot,
  seedContractGeneration,
  cacheNamespace = "",
  perfLabSha,
  teableEeSha,
}) => {
  const normalizedPrimaryKey = requireNonEmptyString(primaryKey, "primaryKey");
  const normalizedMatchedKey = matchedKey.trim();
  const exactHit = cacheHit === true;

  return {
    mode: exactHit
      ? "exact-hit"
      : normalizedMatchedKey
        ? "compatible-candidate"
        : "cache-miss",
    requiresRunnerValidation: !exactHit,
    primaryKey: normalizedPrimaryKey,
    matchedKey: normalizedMatchedKey,
    caseSetDigest: requireNonEmptyString(caseSetDigest, "caseSetDigest"),
    stableSlot: requireNonEmptyString(stableSlot, "stableSlot"),
    seedContractGeneration: requireNonEmptyString(
      seedContractGeneration,
      "seedContractGeneration",
    ),
    cacheNamespace: normalizeSeedCacheNamespace(cacheNamespace),
    perfLabSha: requireCommitSha(perfLabSha, "perfLabSha"),
    teableEeSha: requireCommitSha(teableEeSha, "teableEeSha"),
  };
};
