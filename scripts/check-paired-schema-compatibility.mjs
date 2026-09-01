import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env, requiredEnv } from "./env.mjs";
import { assertPairedSchemaCompatibility } from "./paired-schema-read.mjs";

const baseDir = resolve(requiredEnv("PERF_LAB_PAIRED_BASE_DIR"));
const candidateDir = resolve(requiredEnv("PERF_LAB_PAIRED_CANDIDATE_DIR"));
const result = await assertPairedSchemaCompatibility({
  baseDir,
  candidateDir,
});

const outputPath = env("GITHUB_OUTPUT");
if (outputPath) {
  await appendFile(
    outputPath,
    `compatible=${String(result.compatible)}\ndigest=${result.baseDigest}\n`,
  );
}

console.log(`Paired schema compatible: ${result.baseDigest}`);
