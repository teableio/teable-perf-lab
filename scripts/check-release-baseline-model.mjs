import assert from "node:assert/strict";
import {
  buildBaselineResultsQuery,
  buildBaselineRunQuery,
  buildLatestLaunchQuery,
  buildReleaseBaseline,
  LAUNCH_COMMIT_FIELD,
  LAUNCH_REGION_FIELD_ID,
  LAUNCH_TIME_FIELD_ID,
  readBaselineRun,
  readLatestLaunch,
} from "./release-baseline-model.mjs";

const launchQuery = buildLatestLaunchQuery();
assert.equal(launchQuery.get("fieldKeyType"), "name");
assert.equal(launchQuery.get("take"), "1");
// Without text format the linked `Commit ID` arrives as a one-element array.
assert.equal(launchQuery.get("cellFormat"), "text");
assert.deepEqual(launchQuery.getAll("projection"), [
  "Commit ID",
  "EE Lanched Release",
]);
// Field ids, not names: the launch date column is spelled "Lanuched time", and
// a corrected typo must not silently change which row is read.
assert.deepEqual(JSON.parse(launchQuery.get("orderBy")), [
  { fieldId: LAUNCH_TIME_FIELD_ID, order: "desc" },
]);
assert.deepEqual(JSON.parse(launchQuery.get("filter")), {
  conjunction: "and",
  filterSet: [
    { fieldId: LAUNCH_REGION_FIELD_ID, operator: "is", value: "teable.ai" },
  ],
});
assert.equal(
  JSON.parse(buildLatestLaunchQuery({ region: "teable.cn" }).get("filter"))
    .filterSet[0].value,
  "teable.cn",
);

assert.deepEqual(
  readLatestLaunch([
    {
      id: "reciolkO3PQGpQAGOaJ",
      fields: {
        [LAUNCH_COMMIT_FIELD]: "e0dae6da17f302d3def079b095c5151af3b3581f",
        "EE Lanched Release": "release.2026-07-30T06-45-38Z.2429",
      },
    },
  ]),
  {
    commit: "e0dae6da17f302d3def079b095c5151af3b3581f",
    release: "release.2026-07-30T06-45-38Z.2429",
  },
);
assert.equal(readLatestLaunch([]), undefined);
assert.equal(readLatestLaunch(undefined), undefined);
// A row with an empty commit is a real, quiet state: no baseline.
assert.equal(
  readLatestLaunch([{ id: "rec1", fields: { [LAUNCH_COMMIT_FIELD]: "  " } }]),
  undefined,
);
// A row with no commit column at all means the field was renamed. Reported as
// "no baseline" that would look like an ordinary quiet run forever, so it has
// to fail loudly.
assert.throws(
  () => readLatestLaunch([{ id: "rec2", fields: { Commit: "abc" } }]),
  /has no "Commit ID" field/,
);

const runQuery = buildBaselineRunQuery("e0dae6da");
assert.equal(runQuery.get("take"), "1");
assert.deepEqual(runQuery.getAll("projection"), [
  "Run ID",
  "Run Attempt",
  "Finished At",
]);
assert.deepEqual(JSON.parse(runQuery.get("filter")).filterSet, [
  { fieldId: "Teable EE Ref", operator: "is", value: "e0dae6da" },
]);
// The run lookup must stay typed, so no cellFormat=text here: it would return
// "Run Attempt" as a string and "Finished At" as a localised label.
assert.equal(runQuery.get("cellFormat"), null);
assert.throws(() => buildBaselineRunQuery(""), /release commit is required/);

assert.deepEqual(
  readBaselineRun([
    {
      fields: {
        "Run ID": "30520608995",
        "Run Attempt": 1,
        "Finished At": "2026-07-30T07:06:12.053Z",
      },
    },
  ]),
  {
    runId: "30520608995",
    runAttempt: 1,
    finishedAt: "2026-07-30T07:06:12.053Z",
  },
);
assert.equal(readBaselineRun([]), undefined);
assert.equal(readBaselineRun([{ fields: {} }]), undefined);
assert.equal(
  readBaselineRun([{ fields: { "Run ID": "1", "Run Attempt": null } }])
    .runAttempt,
  1,
);

const resultsQuery = buildBaselineResultsQuery({
  runId: "30520608995",
  runAttempt: 1,
  skip: 1000,
});
assert.equal(resultsQuery.get("take"), "1000");
assert.equal(resultsQuery.get("skip"), "1000");
assert.deepEqual(resultsQuery.getAll("projection"), [
  "Case ID",
  "Engine",
  "Result",
  "Primary Metric",
  "Primary Metric Value",
]);
assert.deepEqual(JSON.parse(resultsQuery.get("filter")).filterSet, [
  { fieldId: "Run ID", operator: "is", value: "30520608995" },
  { fieldId: "Run Attempt", operator: "is", value: 1 },
]);
assert.throws(
  () => buildBaselineResultsQuery({ runId: "" }),
  /baseline run id is required/,
);

const baseline = buildReleaseBaseline({
  launch: { commit: "e0dae6da", release: "release.2429" },
  run: { runId: "30520608995", runAttempt: 1, finishedAt: "2026-07-30" },
  runUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/30520608995",
  records: [
    {
      fields: {
        "Case ID": "duplicate-base/10k",
        Engine: "v1",
        Result: "pass",
        "Primary Metric": "duplicateBaseRequestMs",
        "Primary Metric Value": 2230.07,
      },
    },
    {
      fields: {
        "Case ID": "duplicate-base/10k",
        Engine: "v2",
        Result: "pass",
        "Primary Metric": "duplicateBaseRequestMs",
        "Primary Metric Value": 1100,
      },
    },
    // A failed run measured how long the failure took, not how the released
    // build behaves. Using it would invent a regression or hide one.
    {
      fields: {
        "Case ID": "field-convert/text",
        Engine: "v2",
        Result: "fail",
        "Primary Metric": "convertMs",
        "Primary Metric Value": 90_000,
      },
    },
    {
      fields: {
        "Case ID": "import-base/v2-only",
        Engine: "v1",
        Result: "skipped",
        "Primary Metric Value": null,
      },
    },
    { fields: { "Case ID": "", Engine: "v2", Result: "pass" } },
  ],
});

assert.equal(baseline.commit, "e0dae6da");
assert.equal(baseline.release, "release.2429");
assert.equal(baseline.runId, "30520608995");
assert.equal(baseline.valueCount, 2);
assert.equal(baseline.caseCount, 1);
assert.equal(baseline.unusableCount, 2);
assert.deepEqual(baseline.values["duplicate-base/10k::v2"], {
  value: 1100,
  metric: "duplicateBaseRequestMs",
});
assert.equal(baseline.values["field-convert/text::v2"], undefined);

console.log("release baseline model checks passed.");
