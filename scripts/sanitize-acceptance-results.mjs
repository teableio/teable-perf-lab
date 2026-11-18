// Acceptance runs publish their artifacts from a public repository, so a result
// keeps only the outcome and its numbers. Phases, details, measurement metadata
// and error text can all carry server output and are never copied.

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const finiteOrNull = (value) => (Number.isFinite(value) ? value : null);

export const sanitizeResult = (payload) => ({
  caseId: payload.caseId,
  title: payload.title,
  engine: payload.engine,
  result: payload.result,
  durationMs: finiteOrNull(payload.durationMs),
  metrics: Object.fromEntries(
    Object.entries(payload.metrics ?? {}).filter(([, value]) =>
      Number.isFinite(value),
    ),
  ),
  thresholds: (payload.thresholds ?? []).map((threshold) => ({
    metric: threshold.metric,
    max: finiteOrNull(threshold.max),
    unit: threshold.unit,
    actual: finiteOrNull(threshold.actual),
    passed: threshold.passed === true,
  })),
  ...(payload.error ? { error: "withheld in acceptance mode" } : {}),
});

const isResult = (value) =>
  typeof value?.caseId === "string" &&
  typeof value?.engine === "string" &&
  typeof value?.result === "string";

export const sanitizeResults = async (source, destination) => {
  await mkdir(destination, { recursive: true });
  const names = await readdir(source).catch(() => []);
  let kept = 0;
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const parsed = await readFile(join(source, name), "utf8")
      .then(JSON.parse)
      .catch(() => undefined);
    if (isResult(parsed)) {
      await writeFile(
        join(destination, name),
        `${JSON.stringify(sanitizeResult(parsed), null, 2)}\n`,
      );
      kept += 1;
    }
  }
  return kept;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [source, destination] = process.argv.slice(2);
  if (!source || !destination) {
    throw new Error(
      "Usage: sanitize-acceptance-results.mjs <source> <destination>",
    );
  }
  console.log(`Kept ${await sanitizeResults(source, destination)} results.`);
}
