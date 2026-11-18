// The acceptance counterpart of the report job: print each reduced result and
// fail when a planned case failed or produced no result.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const readResults = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    () => [],
  );
  const results = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await readResults(path)));
    } else if (entry.name.endsWith(".json")) {
      results.push(JSON.parse(await readFile(path, "utf8")));
    }
  }
  return results;
};

export const evaluateResults = (plan, results) => {
  const seen = new Set(results.map((r) => `${r.caseId}|${r.engine}`));
  const missing = plan.flatMap((entry) =>
    entry.caseFilter === "all"
      ? []
      : entry.caseFilter
          .split(",")
          .map((caseId) => caseId.trim())
          .filter(Boolean)
          .filter((caseId) => !seen.has(`${caseId}|${entry.engine}`))
          .map((caseId) => `${caseId} (${entry.engine})`),
  );
  const failed = results
    .filter((result) => result.result === "fail")
    .map((result) => `${result.caseId} (${result.engine})`);
  return {
    missing,
    failed,
    ok: missing.length === 0 && failed.length === 0 && results.length > 0,
  };
};

const formatResult = (result) => {
  const checks = result.thresholds
    .map(
      (t) =>
        `${t.metric}=${t.actual ?? "n/a"}${t.unit ?? ""} (max ${t.max ?? "n/a"})`,
    )
    .join(", ");
  return `${result.result}\t${result.engine}\t${result.caseId}\t${checks}`;
};

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await readResults(process.argv[2]);
  const plan = JSON.parse(process.env.PERF_LAB_EXECUTE_PLAN ?? "[]");
  results.forEach((result) => console.log(formatResult(result)));
  const { missing, failed, ok } = evaluateResults(plan, results);
  missing.forEach((item) => console.error(`No result: ${item}`));
  failed.forEach((item) => console.error(`Failed: ${item}`));
  if (!ok) {
    process.exitCode = 1;
  }
}
