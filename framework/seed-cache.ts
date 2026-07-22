import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { getTableList } from "@teable/openapi";
import type { PerfCase, PerfRunnerKind } from "./types";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

export type SeedCacheIdentity = {
  perfCase: PerfCase;
  runner: PerfRunnerKind;
  fixtureVersion: string;
  seedConfig: JsonValue;
  seedCodeFiles: URL[];
};

export type SeedCacheInfo = {
  enabled: boolean;
  seedAffinity?: string;
  seedHash: string;
  seedHashShort: string;
  seedNamePrefix: string;
  seedTableName: string;
  schemaSignature: string;
};

const DEFAULT_SCHEMA_SIGNATURE = "local";

const stableStringify = (value: JsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key]!)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
};

const hashText = (text: string) =>
  createHash("sha256").update(text).digest("hex");

const hashFiles = async (files: URL[]) => {
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(fileURLToPath(file));
    hash.update("\0");
    hash.update(await readFile(file, "utf8"));
    hash.update("\0");
  }
  return hash.digest("hex");
};

const findNearestCaseFile = async (
  directoryUrl: URL,
  fileName: string,
  remainingDepth = 8,
): Promise<URL | undefined> => {
  if (remainingDepth < 0) {
    return;
  }

  const candidate = new URL(fileName, directoryUrl);
  try {
    await readFile(candidate, "utf8");
    return candidate;
  } catch {
    const parent = new URL("../", directoryUrl);
    if (parent.href === directoryUrl.href) {
      return;
    }
    return findNearestCaseFile(parent, fileName, remainingDepth - 1);
  }
};

const sanitizeNamePart = (value: string, maxLength: number) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);

const buildTableName = (prefix: string, seedHashShort: string, suffix = "") =>
  [prefix, suffix ? sanitizeNamePart(suffix, 16) : undefined, seedHashShort]
    .filter(Boolean)
    .join("-");

export const isSeedCacheEnabled = () =>
  process.env.PERF_LAB_SEED_CACHE_ENABLED === "true";

export const buildSeedCacheInfo = async ({
  perfCase,
  runner,
  fixtureVersion,
  seedConfig,
  seedCodeFiles,
}: SeedCacheIdentity): Promise<SeedCacheInfo> => {
  const schemaSignature =
    process.env.PERF_LAB_SEED_SCHEMA_SIGNATURE ?? DEFAULT_SCHEMA_SIGNATURE;
  const caseFile = await findNearestCaseFile(
    new URL("../", import.meta.url),
    `cases/${perfCase.id}.case.ts`,
  );
  const seedCodeHash = await hashFiles(
    caseFile ? [caseFile, ...seedCodeFiles] : seedCodeFiles,
  );
  const seedHash = hashText(
    stableStringify({
      caseId: perfCase.id,
      runner,
      fixtureVersion,
      schemaSignature,
      seedConfig,
      seedCodeHash,
    }),
  );
  const seedHashShort = seedHash.slice(0, 16);
  const seedNamePrefix = ["perf-seed", sanitizeNamePart(perfCase.id, 24)].join(
    "-",
  );
  const seedTableName = buildTableName(seedNamePrefix, seedHashShort);

  return {
    enabled: isSeedCacheEnabled(),
    ...(perfCase.seedAffinity ? { seedAffinity: perfCase.seedAffinity } : {}),
    seedHash,
    seedHashShort,
    seedNamePrefix,
    seedTableName,
    schemaSignature,
  };
};

export const buildSeedTableName = (seedCacheInfo: SeedCacheInfo, suffix = "") =>
  buildTableName(
    seedCacheInfo.seedNamePrefix,
    seedCacheInfo.seedHashShort,
    suffix,
  );

export const findSeedTable = async (baseId: string, seedTableName: string) => {
  const response = await getTableList(baseId);
  return response.data.find((table) => table.name === seedTableName);
};
