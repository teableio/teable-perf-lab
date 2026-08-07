import assert from "node:assert/strict";
import {
  buildBaselineRecordsQuery,
  buildLatestLaunchQuery,
  buildReleaseBaseline,
  LAUNCH_COMMIT_FIELD,
  LAUNCH_REGION_FIELD_ID,
  LAUNCH_TIME_FIELD_ID,
  readLatestLaunch,
  selectBaselineRun,
  TEABLE_EE_REF_FIELD_ID,
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

const recordsQuery = buildBaselineRecordsQuery({
  commit: "e0dae6da",
  skip: 1000,
});
assert.equal(recordsQuery.get("take"), "1000");
assert.equal(recordsQuery.get("skip"), "1000");
// The commit's rows carry their own run identity, which is what removes the
// separate "which run measured this commit" round trip. Everything else here is
// what the summary reads; nothing is projected for its own sake.
// `Metrics JSON` is the exception to "nothing for its own sake": compute time
// has no column of its own and rides inside that blob, at 689 bytes per row
// against the ~25 KB/row that made an unprojected read fail outright.
assert.deepEqual(recordsQuery.getAll("projection"), [
  "Run ID",
  "Run Attempt",
  "Case ID",
  "Engine",
  "Result",
  "Primary Metric",
  "Primary Metric Value",
  "Metrics JSON",
]);
// By field id, like the launch query: a renamed column does not fail this
// request, it drops the condition and returns the whole table.
assert.deepEqual(JSON.parse(recordsQuery.get("filter")).filterSet, [
  { fieldId: TEABLE_EE_REF_FIELD_ID, operator: "is", value: "e0dae6da" },
]);
// Nothing is sorted server-side: a renamed sort field is silently ignored, and
// the newest run is chosen here from the complete set instead.
assert.equal(recordsQuery.get("orderBy"), null);
// No cellFormat=text: it would hand back "Run Attempt" and the metric value as
// localised strings.
assert.equal(recordsQuery.get("cellFormat"), null);
assert.throws(
  () => buildBaselineRecordsQuery({ commit: "" }),
  /release commit is required/,
);

// GitHub issues run ids in increasing order, so the newest run wins regardless
// of the order rows arrive in.
assert.deepEqual(
  selectBaselineRun([
    { fields: { "Run ID": "30520608995", "Run Attempt": 1 } },
    { fields: { "Run ID": "9999999999", "Run Attempt": 1 } },
    { fields: { "Run ID": "30890523711", "Run Attempt": 1 } },
  ]),
  { runId: "30890523711", runAttempt: 1 },
);
// A rerun of the same run is a later attempt, not a later id.
assert.deepEqual(
  selectBaselineRun([
    { fields: { "Run ID": "30520608995", "Run Attempt": 2 } },
    { fields: { "Run ID": "30520608995", "Run Attempt": 1 } },
  ]),
  { runId: "30520608995", runAttempt: 2 },
);
// `Number(null)` is 0, and attempt 0 does not exist: an unset attempt has to
// fold into attempt 1 or one run splits into two.
assert.equal(
  selectBaselineRun([{ fields: { "Run ID": "1", "Run Attempt": null } }])
    .runAttempt,
  1,
);
assert.equal(selectBaselineRun([]), undefined);
assert.equal(selectBaselineRun(undefined), undefined);
assert.equal(selectBaselineRun([{ fields: {} }]), undefined);

const chosenRun = { "Run ID": "30520608995", "Run Attempt": 1 };
const records = [
  {
    fields: {
      ...chosenRun,
      "Case ID": "duplicate-base/10k",
      Engine: "v1",
      Result: "pass",
      "Primary Metric": "duplicateBaseRequestMs",
      "Primary Metric Value": 2230.07,
    },
  },
  {
    fields: {
      ...chosenRun,
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
      ...chosenRun,
      "Case ID": "field-convert/text",
      Engine: "v2",
      Result: "fail",
      "Primary Metric": "convertMs",
      "Primary Metric Value": 90_000,
    },
  },
  {
    fields: {
      ...chosenRun,
      "Case ID": "import-base/v2-only",
      Engine: "v1",
      Result: "skipped",
      "Primary Metric Value": null,
    },
  },
  { fields: { ...chosenRun, "Case ID": "", Engine: "v2", Result: "pass" } },
  // An earlier run of the same commit. The query filters on the commit, so
  // these arrive too — and they are neither baseline values nor unusable
  // measurements, they simply describe a different run.
  {
    fields: {
      "Run ID": "30400000000",
      "Run Attempt": 1,
      "Case ID": "duplicate-base/10k",
      Engine: "v2",
      Result: "pass",
      "Primary Metric": "duplicateBaseRequestMs",
      "Primary Metric Value": 4242,
    },
  },
  {
    fields: {
      "Run ID": "30400000000",
      "Run Attempt": 1,
      "Case ID": "gone-since/case",
      Engine: "v2",
      Result: "fail",
      "Primary Metric Value": 7,
    },
  },
];

assert.deepEqual(selectBaselineRun(records), {
  runId: "30520608995",
  runAttempt: 1,
});

const baseline = buildReleaseBaseline({
  launch: { commit: "e0dae6da", release: "release.2429" },
  run: selectBaselineRun(records),
  runUrl:
    "https://github.com/teableio/teable-perf-lab/actions/runs/30520608995",
  records,
});

assert.equal(baseline.commit, "e0dae6da");
assert.equal(baseline.release, "release.2429");
assert.equal(baseline.runId, "30520608995");
assert.equal(baseline.runAttempt, 1);
// The artifact carries no `finishedAt`: nothing renders it, so nothing projects
// the column that would supply it.
assert.equal("finishedAt" in baseline, false);
assert.equal(baseline.valueCount, 2);
assert.equal(baseline.caseCount, 1);
assert.equal(baseline.unusableCount, 2);
// The chosen run's value, not the earlier run's 4242.
assert.deepEqual(baseline.values["duplicate-base/10k::v2"], {
  value: 1100,
  metric: "duplicateBaseRequestMs",
});
assert.equal(baseline.values["field-convert/text::v2"], undefined);
// A case only the earlier run measured is absent rather than backfilled: the
// baseline describes one run, and the summary reports it as missing.
assert.equal(baseline.values["gone-since/case::v2"], undefined);
// Rows measured before compute collection shipped carry no compute key at all,
// which the comparison reads as "no baseline" rather than as zero.
assert.equal("compute" in baseline.values["duplicate-base/10k::v2"], false);

// Compute time rides inside `Metrics JSON`, which arrives as text.
const computeBaseline = buildReleaseBaseline({
  launch: { commit: "e0dae6da" },
  run: { runId: "30520608995", runAttempt: 1 },
  records: [
    {
      fields: {
        ...chosenRun,
        "Case ID": "lookup/flip",
        Engine: "v2",
        Result: "pass",
        "Primary Metric": "opMs",
        "Primary Metric Value": 1100,
        "Metrics JSON": JSON.stringify({
          opMs: 1100,
          computeMs: 836.29,
          computeAsyncMs: 836.29,
          computeTaskCount: 16,
        }),
      },
    },
    // Anything can be in a text column: an older schema, a truncated write. One
    // unreadable blob costs the compute half of one case, never the run.
    {
      fields: {
        ...chosenRun,
        "Case ID": "lookup/torn",
        Engine: "v2",
        Result: "pass",
        "Primary Metric": "opMs",
        "Primary Metric Value": 900,
        "Metrics JSON": '{"computeMs": 83',
      },
    },
  ],
});

assert.deepEqual(computeBaseline.values["lookup/flip::v2"].compute, {
  value: 836.29,
  shape: "outbox",
});
assert.equal("compute" in computeBaseline.values["lookup/torn::v2"], false);
assert.equal(computeBaseline.values["lookup/torn::v2"].value, 900);
assert.equal(computeBaseline.computeCount, 1);
// The torn blob is unreadable, not merely compute-free. Counting them the same
// way would make a column this code can no longer read look identical to the
// legitimate "no compute measured yet" state.
assert.equal(computeBaseline.metricsReadable, 1);
assert.equal(computeBaseline.metricsUnreadable, 1);

// Rows written before compute collection shipped: readable, just no compute.
// This is the state that must NOT look like a broken column.
assert.equal(baseline.computeCount, 0);
assert.equal(baseline.metricsReadable, 0);
assert.equal(baseline.metricsUnreadable, 0);

console.log("release baseline model checks passed.");
