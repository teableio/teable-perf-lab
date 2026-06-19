#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

/*
 * G1 artifact diff guardrail.
 *
 * Mask rule: first run an unmigrated case twice in the same environment, then
 * compare those same-code artifacts. Fields that differ there are runtime
 * noise and belong here; fields that survive this normalization are behavioral
 * evidence. This keeps semantic fields visible: metric keys, threshold
 * metric/max/unit, phase names and order, details.operation, replaySetup keys,
 * routing assertions, verifiedSamples.expected, rowCount, and batchSize.
 */

const VOLATILE = "<volatile>";

const readJson = async (file) => JSON.parse(await readFile(file, "utf8"));

const isObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isArrayIndex = (value) => typeof value === "number";

const pathEquals = (path, expected) =>
  path.length === expected.length &&
  path.every((segment, index) => segment === expected[index]);

const maskMetricValues = (metrics) =>
  Object.fromEntries(
    Object.keys(metrics)
      .sort()
      .map((metric) => [
        metric,
        typeof metrics[metric] === "number" ? VOLATILE : metrics[metric],
      ]),
  );

const maskReplaySetupValues = (replaySetup) =>
  Object.fromEntries(
    Object.keys(replaySetup)
      .sort()
      .map((metric) => [
        metric,
        typeof replaySetup[metric] === "number"
          ? VOLATILE
          : normalize(replaySetup[metric], ["details", "replaySetup", metric]),
      ]),
  );

const GENERATED_ID_KEYS = new Set([
  "createdTableId",
  "fieldId",
  "foreignTableId",
  "linkFieldId",
  "linkTargetId",
  "mainTableId",
  "recordId",
  "tableId",
  "trashId",
  "viewId",
  // Generated record ids produced by the duplicate runners. Each run seeds a
  // fresh table, so the duplicated/source record ids differ between two runs of
  // unchanged code (confirmed by the record-duplicate baseline A vs B diff).
  // Counts (requestCount/duplicatedCount/totalCount) stay visible; only the
  // opaque id strings are masked, like the existing `recordId`.
  "createdRecordIds",
  "duplicatedRecordIds",
  "sourceRecordId",
  "duplicatedRecordId",
]);

const GENERATED_NAME_KEYS = new Set(["foreignTableName", "tableName"]);

const shouldMaskKey = (path, key) => {
  if (
    path.length === 0 &&
    ["runId", "appUrl", "startedAt", "finishedAt"].includes(key)
  ) {
    return true;
  }

  if (key === "durationMs") {
    return true;
  }

  if (typeof key === "string" && key.endsWith("Ms") && key !== "maxMs") {
    return true;
  }

  if (key === "traceparent") {
    return true;
  }

  if (GENERATED_ID_KEYS.has(key)) {
    return true;
  }

  if (path[0] === "details" && GENERATED_NAME_KEYS.has(key)) {
    return true;
  }

  if (key === "deletedTime") {
    return true;
  }

  if (pathEquals(path, ["thresholds"]) && isArrayIndex(key)) {
    return false;
  }

  if (
    path.length === 2 &&
    path[0] === "thresholds" &&
    isArrayIndex(path[1]) &&
    ["actual", "passed"].includes(key)
  ) {
    return true;
  }

  if (
    pathEquals(path, ["details"]) &&
    ["windowId", "tableId", "tableName", "dbTableName", "viewId"].includes(key)
  ) {
    return true;
  }

  if (pathEquals(path, ["details"]) && key === "deletedFieldIds") {
    return true;
  }

  if (
    pathEquals(path, ["details", "import"]) &&
    ["createdTableId", "requestMs"].includes(key)
  ) {
    return true;
  }

  // The duplicate runners echo the live request back in details.request: `path`
  // embeds the freshly-seeded table id and `projection` is the list of generated
  // field ids. Both differ between two runs of unchanged code (record-duplicate
  // baseline A vs B). details.operation + details.request.method keep the
  // endpoint identity visible.
  if (
    pathEquals(path, ["details", "request"]) &&
    ["path", "projection"].includes(key)
  ) {
    return true;
  }

  if (
    pathEquals(path, ["details", "import", "completion"]) &&
    ["pollCount", "tableId"].includes(key)
  ) {
    return true;
  }

  if (
    path.length === 3 &&
    path[0] === "details" &&
    path[1] === "fields" &&
    isArrayIndex(path[2]) &&
    key === "id"
  ) {
    return true;
  }

  if (
    path.length >= 2 &&
    path[path.length - 2] === "verifiedSamples" &&
    isArrayIndex(path[path.length - 1]) &&
    key === "recordId"
  ) {
    return true;
  }

  if (
    path.at(-1) === "cache" &&
    ["seedHash", "seedHashShort", "seedTableName"].includes(key)
  ) {
    return true;
  }

  if (pathEquals(path, ["details", "seed"]) && key === "maxSeedBatchMs") {
    return true;
  }

  return false;
};

function normalize(value, path = []) {
  if (Array.isArray(value)) {
    return value.map((item, index) => normalize(item, [...path, index]));
  }

  if (!isObject(value)) {
    return value;
  }

  if (pathEquals(path, ["metrics"])) {
    return maskMetricValues(value);
  }

  if (pathEquals(path, ["details", "replaySetup"])) {
    return maskReplaySetupValues(value);
  }

  if (pathEquals(path, ["details", "observability"])) {
    return VOLATILE;
  }

  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [
        key,
        shouldMaskKey(path, key)
          ? VOLATILE
          : normalize(value[key], [...path, key]),
      ]),
  );
}

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
