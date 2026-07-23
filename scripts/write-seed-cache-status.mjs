import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { buildSeedCacheStatus } from "./seed-cache-model.mjs";

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set`);
  }
  return value;
};

const outputPath = requiredEnv("OUTPUT_PATH");
const status = buildSeedCacheStatus({
  cacheHit: process.env.CACHE_HIT === "true",
  primaryKey: requiredEnv("CACHE_PRIMARY_KEY"),
  matchedKey: process.env.CACHE_MATCHED_KEY,
  caseSetDigest: requiredEnv("CASE_SET_DIGEST"),
  stableSlot: requiredEnv("STABLE_SLOT"),
  seedContractGeneration: requiredEnv("SEED_CONTRACT_GENERATION"),
  cacheNamespace: process.env.SEED_CACHE_NAMESPACE,
  perfLabSha: requiredEnv("PERF_LAB_SHA"),
  teableEeSha: requiredEnv("TEABLE_EE_SHA"),
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(status, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `cache_mode=${status.mode}`,
      `requires_seed_validation=${String(status.requiresRunnerValidation)}`,
      "",
    ].join("\n"),
  );
}
console.log(`Seed cache mode: ${status.mode}`);
