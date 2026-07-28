// Case-description guardrail.
//
// Every case states its guardrail twice: once as `config.threshold.maxMs` in
// `cases/**/*.case.ts`, and again in prose in the same-name `.md`. Nothing
// checked the prose, and it drifted — `record-read/50k-50fields-filter-sort-
// groupby-selective` was raised to 60,000 while its description kept the 50k
// family's boilerplate "initial maximum 30,000 ms".
//
// Before checking the real repo this self-tests the detector against synthetic
// descriptions, so a regression in the detector itself (which would make the
// guard silently useless) also fails.

import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listCaseDocIssues,
  loadCaseCatalog,
  parseCaseThresholdRestatements,
} from "./case-catalog.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(`Self-test failed: ${message}`);
  }
};

const same = (actual, expected, message) =>
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${message} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`,
  );

// Positive path: the shapes a description actually uses must be recognised.
const selfTestParser = () => {
  same(
    parseCaseThresholdRestatements("`maxMs` is 6,000. It was raised from 4,000."),
    [6000],
    "unit-less `maxMs` restatement; a loose history number is not a restatement",
  );
  same(
    parseCaseThresholdRestatements("`maxMs` (2,000) is calibrated from CI."),
    [2000],
    "parenthesised `maxMs` restatement",
  );
  same(
    parseCaseThresholdRestatements("The initial `maxMs` is 10 seconds: ..."),
    [10000],
    "seconds are normalised to milliseconds",
  );
  same(
    parseCaseThresholdRestatements("clamped at zero; initial maximum 30,000 ms."),
    [30000],
    "bare duration inside a threshold sentence",
  );

  // Negative path: each of these used to produce a false positive.
  same(
    parseCaseThresholdRestatements("Poll `getRecords` every 100 ms until ready."),
    [],
    "polling interval is not a threshold",
  );
  // Observations sitting inside a threshold sentence are still collected; the
  // "at least one stated value must match" rule below is what keeps them from
  // failing the guard. Erring this way costs a miss, never a false alarm.
  same(
    parseCaseThresholdRestatements(
      "`maxMs` (2,000) calibrated from CI history (p95 ~320ms, worst ~450ms).",
    ),
    [2000, 320, 450],
    "the declared threshold is collected alongside nearby observations",
  );
  same(
    parseCaseThresholdRestatements("Primary metric is `formSubmitP95Ms` overall."),
    [],
    "a metric name is not a duration",
  );
  same(
    parseCaseThresholdRestatements(
      "`maxMs` is 6,000 after a valid 4,451.78ms CI result.",
    ),
    [6000],
    "a decimal tail is not a duration",
  );
};

// Negative path: a drifted description must be reported, an agreeing or silent
// one must not.
const selfTestDetector = () => {
  const entry = (markdown, primaryThresholdMs) => ({
    casePath: "cases/a/x.case.ts",
    markdownPath: "cases/a/x.md",
    markdown,
    primaryThresholdMs,
  });

  same(
    listCaseDocIssues([entry("initial maximum 30,000 ms.", 60_000)]).map(
      ({ type }) => type,
    ),
    ["threshold-doc-drift"],
    "drifted description is reported",
  );
  same(
    listCaseDocIssues([entry("initial maximum 60,000 ms.", 60_000)]),
    [],
    "agreeing description is accepted",
  );
  same(
    listCaseDocIssues([entry("No guardrail prose at all here.", 60_000)]),
    [],
    "description without a threshold restatement is accepted",
  );
  same(
    listCaseDocIssues([
      entry("`maxMs` is 6,000, raised from the original 30,000ms guardrail.", 6_000),
    ]),
    [],
    "superseded guardrail cited as history is accepted",
  );
};

const main = async () => {
  selfTestParser();
  selfTestDetector();

  const catalog = await loadCaseCatalog(repoRoot);
  const entries = await Promise.all(
    catalog.map(async (entry) => ({
      casePath: entry.casePath,
      markdownPath: entry.markdownPath,
      markdown: await readFile(join(repoRoot, entry.markdownPath), "utf8"),
      primaryThresholdMs: entry.primaryThresholdMs,
    })),
  );

  const issues = listCaseDocIssues(entries);
  if (issues.length > 0) {
    throw new Error(
      `Perf case descriptions disagree with their thresholds (${issues.length}):\n` +
        issues.map(({ detail }) => `  - ${detail}`).join("\n"),
    );
  }

  const restating = entries.filter(
    ({ markdown }) => parseCaseThresholdRestatements(markdown).length > 0,
  ).length;
  console.log(
    `Perf case descriptions ok (${restating} of ${entries.length} restate a threshold; all agree with their case config).`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
