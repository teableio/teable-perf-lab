#!/usr/bin/env node

// Pin a published trace so the daily prune leaves it alone.
//
// Retention is deliberately short: a full run publishes a few hundred traces
// and almost all of them stop mattering when the next run lands. The ones that
// do matter are the ones someone linked in an issue, and those need an address
// that outlives the run. Pinning copies the published trace into `pinned/`,
// which `publishTraceSite` never prunes.

import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "../framework/atomic-file.js";

const PINNED_DIR = "pinned";

const writeJson = (path, value) =>
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);

const readJsonIfPossible = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

const readPinnedIndex = async (siteDir) =>
  (await readJsonIfPossible(join(siteDir, PINNED_DIR, "index.json"))) ?? {
    traces: [],
  };

export const pinTrace = async ({ siteDir, runId, traceId, pinnedAt }) => {
  const source = join(siteDir, "r", runId, `${traceId}.json`);
  const document = await readJsonIfPossible(source);
  if (!document) {
    throw new Error(
      `Trace ${traceId} is not published under run ${runId}; it may already have been pruned.`,
    );
  }

  await mkdir(join(siteDir, PINNED_DIR), { recursive: true });
  await writeJson(join(siteDir, PINNED_DIR, `${traceId}.json`), {
    ...document,
    pinnedAt,
    pinnedFromRunId: runId,
  });

  const index = await readPinnedIndex(siteDir);
  const traces = (index.traces ?? []).filter(
    (entry) => entry?.traceId !== traceId,
  );
  traces.push({
    traceId,
    runId,
    pinnedAt,
    caseId: document.case?.caseId,
    engine: document.case?.engine,
    result: document.case?.result,
    durationMs: document.case?.durationMs,
  });
  traces.sort((left, right) =>
    String(right.pinnedAt ?? "").localeCompare(String(left.pinnedAt ?? "")),
  );
  await writeJson(join(siteDir, PINNED_DIR, "index.json"), { traces });
  return { traceId, runId, pinnedAt, pinnedCount: traces.length };
};

export const unpinTrace = async ({ siteDir, traceId }) => {
  const index = await readPinnedIndex(siteDir);
  const traces = (index.traces ?? []).filter(
    (entry) => entry?.traceId !== traceId,
  );
  if (traces.length === (index.traces ?? []).length) {
    throw new Error(`Trace ${traceId} is not pinned.`);
  }
  await rm(join(siteDir, PINNED_DIR, `${traceId}.json`), { force: true });
  await writeJson(join(siteDir, PINNED_DIR, "index.json"), { traces });
  return { traceId, pinnedCount: traces.length };
};

const optionalArgument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const requiredArgument = (name) => {
  const value = optionalArgument(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const main = async () => {
  const siteDir = resolve(requiredArgument("--site"));
  const traceId = requiredArgument("--trace-id");

  if (process.argv.includes("--unpin")) {
    const result = await unpinTrace({ siteDir, traceId });
    console.log(
      `Unpinned ${result.traceId}; ${result.pinnedCount} traces remain pinned.`,
    );
    return;
  }

  const result = await pinTrace({
    siteDir,
    runId: requiredArgument("--run-id"),
    traceId,
    pinnedAt: optionalArgument("--now") ?? new Date().toISOString(),
  });
  console.log(
    `Pinned ${result.traceId} from run ${result.runId}; ${result.pinnedCount} traces pinned.`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
