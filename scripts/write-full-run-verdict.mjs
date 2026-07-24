#!/usr/bin/env node

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { evaluateFullRunVerdict } from "./full-run-acceptance-model.mjs";

const requiredEnv = (name) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} must be set.`);
  }
  return value;
};

const booleanEnv = (name) => {
  const value = requiredEnv(name);
  if (!["true", "false"].includes(value)) {
    throw new Error(`${name} must be true or false.`);
  }
  return value === "true";
};

const verdict = evaluateFullRunVerdict({
  fullRun: booleanEnv("PERF_LAB_CASE_FILTER_IS_ALL"),
  executeConclusion: requiredEnv("PERF_LAB_EXECUTE_RESULT"),
  seedAffinityOutcome: process.env.PERF_LAB_SEED_AFFINITY_OUTCOME || "skipped",
  resultAcceptanceOutcome:
    process.env.PERF_LAB_RESULT_ACCEPTANCE_OUTCOME || "skipped",
});
const outputPath = requiredEnv("PERF_LAB_RUN_VERDICT_PATH");
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(verdict, null, 2)}\n`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `status=${verdict.status}`,
      `passed=${String(verdict.passed)}`,
      `reason_codes=${verdict.failures.map(({ code }) => code).join(",")}`,
      "",
    ].join("\n"),
  );
}

console.log(JSON.stringify(verdict, null, 2));
