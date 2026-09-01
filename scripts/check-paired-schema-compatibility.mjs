import { execFile } from "node:child_process";
import { appendFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { env, requiredEnv } from "./env.mjs";
import {
  compareSchemaTrees,
  PAIRED_SCHEMA_PATHS,
} from "./paired-schema-model.mjs";

const execFileAsync = promisify(execFile);

const entriesOf = async (directory) => {
  const { stdout } = await execFileAsync(
    "git",
    ["ls-tree", "-r", "HEAD", "--", ...PAIRED_SCHEMA_PATHS],
    { cwd: directory, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
};

const baseDir = resolve(requiredEnv("PERF_LAB_PAIRED_BASE_DIR"));
const candidateDir = resolve(requiredEnv("PERF_LAB_PAIRED_CANDIDATE_DIR"));
const result = compareSchemaTrees({
  baseEntries: await entriesOf(baseDir),
  candidateEntries: await entriesOf(candidateDir),
});

const outputPath = env("GITHUB_OUTPUT");
if (outputPath) {
  await appendFile(
    outputPath,
    `compatible=${String(result.compatible)}\ndigest=${result.baseDigest}\n`,
  );
}

if (!result.compatible) {
  throw new Error(
    `Base and candidate database schemas differ (${result.baseDigest.slice(0, 12)} != ${result.candidateDigest.slice(0, 12)}). A shared restored fixture would not be a controlled comparison.`,
  );
}

console.log(`Paired schema compatible: ${result.baseDigest}`);
