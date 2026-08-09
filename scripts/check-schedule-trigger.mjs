// The nightly run has to plan the same thing a hand-dispatched full run plans.
//
// `inputs` is null on a scheduled run. Every input the workflow reads therefore
// answers empty on that path, and empty is not the dispatch default — it is
// whatever the consumer does with nothing. An empty `case_filter` does not plan
// a full run, an empty `teable_ee_ref` checks out teable-ee's own default
// branch, and an empty concurrency key puts a scheduled full run on the
// per-ref single-case group, which is the one arrangement that lets two full
// runs overlap and measure each other's noise.
//
// None of those fail. They produce a run that looks like a run and is planning
// something else — and a scheduled run that is not a full run does not count
// toward acceptance G1, which is the whole reason the schedule exists. This is
// the same failure shape as the shallow clone and the unasked old gate: a
// well-formed result computed from an input nobody checked.
//
// So the rule is mechanical and checked here: every input carries its dispatch
// default explicitly for the schedule path, or is listed below as one where
// empty is the correct answer.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

// Overridable so the check can be pointed at a mutated copy and shown to fail.
// A guard nobody has watched fail is a guard nobody knows the shape of.
const WORKFLOW_PATH =
  process.env.PERF_LAB_WORKFLOW_PATH ??
  ".github/workflows/teable-ee-e2e-perf.yml";
const text = readFileSync(WORKFLOW_PATH, "utf8");
const workflow = parse(text);

// Inputs whose empty value on a scheduled run is exactly what a full run wants.
// Each one is optional on dispatch too, with an empty default.
const EMPTY_IS_CORRECT = new Set([
  // Guard that only applies to a dispatch pinning an exact perf-lab SHA.
  "expected_perf_lab_sha",
  // Empty keeps the e2e default (sync), which is what the measured history is.
  "computed_update_mode",
  // Empty means the shared seed cache rather than an isolated namespace.
  "seed_cache_namespace",
  // Empty keeps each case's own declared threshold.
  "primary_threshold_ms",
]);

// --- the trigger exists -------------------------------------------------------

const schedule = workflow.on?.schedule;
assert.ok(
  Array.isArray(schedule) && schedule.length > 0,
  "the nightly schedule is what makes the ten-run validation not depend on someone pressing a button",
);
for (const entry of schedule) {
  assert.match(
    String(entry.cron),
    /^[\d*,/\- ]+$/,
    `cron ${entry.cron} is not a cron expression`,
  );
}

// --- every input carries a schedule default -----------------------------------

const declared = Object.keys(workflow.on?.workflow_dispatch?.inputs ?? {});
assert.ok(declared.length > 0, "workflow_dispatch inputs disappeared");

for (const name of declared) {
  if (EMPTY_IS_CORRECT.has(name)) continue;

  // Every expression that reads this input, one per occurrence. A workflow
  // expression cannot span a blank line, so the surrounding `${{ … }}` is
  // enough context to see whether the schedule path was handled — except for
  // the concurrency key, which is a block scalar and is checked separately
  // below.
  const uses = [
    ...text.matchAll(
      new RegExp(`\\$\\{\\{[^}]*inputs\\.${name}[^}]*\\}\\}`, "gs"),
    ),
  ];
  assert.ok(
    uses.length > 0,
    `input ${name} is declared and never read; either wire it or drop it`,
  );
  for (const [expression] of uses) {
    assert.match(
      expression,
      /event_name == 'schedule'/,
      `\`${expression.trim()}\` reads ${name} without a value for the schedule path, where inputs is null. ` +
        `Write it as \`github.event_name == 'schedule' && '<dispatch default>' || inputs.${name}\`, ` +
        `or add ${name} to EMPTY_IS_CORRECT with the reason.`,
    );
  }
}

// --- the scheduled run is a full run ------------------------------------------

const caseFilter = text.match(/CASE_FILTER: (.*)/)?.[1] ?? "";
assert.match(
  caseFilter,
  /event_name == 'schedule' && 'all'/,
  "a scheduled run must plan every case: G1 counts full runs, and a partial one silently does not count",
);

const group = workflow.concurrency?.group ?? "";
assert.match(
  group,
  /event_name == 'schedule'/,
  "a scheduled full run must take the full-run concurrency key, or two full runs can overlap and measure each other's noise",
);

console.log("schedule trigger checks passed");
