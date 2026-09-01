import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  compareSchemaTrees,
  PAIRED_SCHEMA_PATHS,
} from "./paired-schema-model.mjs";

const execFileAsync = promisify(execFile);

export const schemaEntriesAtHead = async (directory) => {
  const entries = [];
  for (const path of PAIRED_SCHEMA_PATHS) {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["rev-parse", `HEAD:${path}`],
        { cwd: directory },
      );
      entries.push(`${path} ${stdout.trim()}`);
    } catch (error) {
      if (error?.code === 128) continue;
      throw error;
    }
  }
  return entries.join("\n");
};

const assertHead = async ({ directory, expectedSha, label }) => {
  if (!expectedSha) return;
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
    cwd: directory,
  });
  if (stdout.trim().toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(
      `${label} checkout HEAD does not match the immutable SHA in the paired plan`,
    );
  }
};

export const assertPairedSchemaCompatibility = async ({
  baseDir,
  candidateDir,
  baseSha,
  candidateSha,
}) => {
  await assertHead({ directory: baseDir, expectedSha: baseSha, label: "base" });
  await assertHead({
    directory: candidateDir,
    expectedSha: candidateSha,
    label: "candidate",
  });
  const result = compareSchemaTrees({
    baseEntries: await schemaEntriesAtHead(baseDir),
    candidateEntries: await schemaEntriesAtHead(candidateDir),
  });
  if (!result.compatible) {
    throw new Error(
      `Base and candidate database schemas differ (${result.baseDigest.slice(0, 12)} != ${result.candidateDigest.slice(0, 12)}). A shared restored fixture would not be a controlled comparison.`,
    );
  }
  return result;
};
