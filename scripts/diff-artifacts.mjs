#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { normalize } from "./perf-artifact-diff-model.mjs";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const main = async () => {
  const [baselineFile, candidateFile] = process.argv.slice(2);
  if (!baselineFile || !candidateFile) {
    console.error(
      "Usage: node scripts/diff-artifacts.mjs <baseline.json> <candidate.json>",
    );
    process.exitCode = 2;
    return;
  }

  try {
    const baseline = normalize(await readJson(baselineFile));
    const candidate = normalize(await readJson(candidateFile));
    assert.deepStrictEqual(candidate, baseline);
    console.log(
      `Artifact diff ok: ${basename(baselineFile)} ~= ${basename(candidateFile)}`,
    );
  } catch (error) {
    console.error(
      `Artifact diff fail: ${basename(baselineFile)} != ${basename(candidateFile)}`,
    );
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
};

await main();
