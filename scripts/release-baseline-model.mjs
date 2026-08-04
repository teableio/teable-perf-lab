// Request shapes and parsing for the released-build baseline.
//
// Two tables, two tokens: the Launches table (`TEABLE_LAUNCHES_TOKEN`, read
// only, a different base) names the commit currently deployed, and the
// Performance Track table (`TEABLE_PERF_LAB_TOKEN`) holds the run that measured
// it. Keep fetch/filesystem work in `resolve-release-baseline.mjs`.
//
// Every query here is bounded on purpose. The Performance Track rows carry
// Metrics/Phases/Trace-Manifest JSON and Summary Markdown, so an unprojected
// read of 100 rows is 2.5 MB and the API rejects it outright; the projected
// baseline page below is 540 rows in ~208 KB, and the launch lookup is one
// record in under 500 bytes.

// Written by the resolver into the artifact directory, read by both summaries.
// Declared here, not in the resolver: importing it from a script whose module
// body runs `main()` would fire a Teable fetch on import.
export const RELEASE_BASELINE_FILE_NAME = "release-baseline.json";

export const LAUNCHES_TABLE_ID = "tblmGAFOHrGcy66PaUp";

// Filter and sort by field id, not name. The launch date field is spelled
// "Lanuched time" in the table; if that typo is ever corrected, a name-based
// query would start returning the wrong row — or no row — silently.
export const LAUNCH_REGION_FIELD_ID = "fldgnjjC1JuSk4BOcXD";
export const LAUNCH_TIME_FIELD_ID = "fldm9FHCtUzc73bRaDK";

export const LAUNCH_COMMIT_FIELD = "Commit ID";
export const LAUNCH_RELEASE_FIELD = "EE Lanched Release";

// One launch writes one row per region with the same commit, so a single region
// is the whole story. A rollback is recorded as a later row, and the commit it
// names is what is serving traffic, so the newest row wins regardless of
// Operation Type.
export const DEFAULT_LAUNCH_REGION = "teable.ai";

export const BASELINE_RESULTS_PAGE_SIZE = 1000;

const searchParams = (entries) => {
  const params = new URLSearchParams();
  for (const [key, value] of entries) {
    if (value !== undefined) {
      params.append(key, String(value));
    }
  }
  return params;
};

export const buildLatestLaunchQuery = ({
  region = DEFAULT_LAUNCH_REGION,
} = {}) =>
  searchParams([
    ["fieldKeyType", "name"],
    ["take", 1],
    // `Commit ID` is derived from the Related Releases link, so the default cell
    // format returns it as a one-element array. Text format hands back the bare
    // SHA and keeps the caller from unwrapping.
    ["cellFormat", "text"],
    ["projection", LAUNCH_COMMIT_FIELD],
    ["projection", LAUNCH_RELEASE_FIELD],
    [
      "orderBy",
      JSON.stringify([{ fieldId: LAUNCH_TIME_FIELD_ID, order: "desc" }]),
    ],
    [
      "filter",
      JSON.stringify({
        conjunction: "and",
        filterSet: [
          { fieldId: LAUNCH_REGION_FIELD_ID, operator: "is", value: region },
        ],
      }),
    ],
  ]);

/**
 * Read the deployed commit from a Launches response.
 *
 * Returns undefined when the table has no launch for the region — that is a
 * real state, and the summary renders it as "no baseline". A row that exists
 * but carries no `Commit ID` key means the field was renamed, which must fail
 * loudly instead: reported as "no baseline" it would look like an ordinary
 * quiet run forever.
 */
export const readLatestLaunch = (records) => {
  const [record] = records ?? [];
  if (!record) {
    return undefined;
  }

  const fields = record.fields ?? {};
  if (!Object.hasOwn(fields, LAUNCH_COMMIT_FIELD)) {
    throw new Error(
      `Launches record ${record.id ?? "?"} has no "${LAUNCH_COMMIT_FIELD}" field; the field was renamed or the projection is stale.`,
    );
  }

  const commit = String(fields[LAUNCH_COMMIT_FIELD] ?? "").trim();
  if (!commit) {
    return undefined;
  }

  return {
    commit,
    release: String(fields[LAUNCH_RELEASE_FIELD] ?? "").trim() || undefined,
  };
};

export const buildBaselineRunQuery = (commit) => {
  if (!commit) {
    throw new Error("A release commit is required to find its baseline run.");
  }
  return searchParams([
    ["fieldKeyType", "name"],
    ["take", 1],
    ["projection", "Run ID"],
    ["projection", "Run Attempt"],
    ["projection", "Finished At"],
    ["orderBy", JSON.stringify([{ fieldId: "Finished At", order: "desc" }])],
    [
      "filter",
      JSON.stringify({
        conjunction: "and",
        filterSet: [
          { fieldId: "Teable EE Ref", operator: "is", value: commit },
        ],
      }),
    ],
  ]);
};

export const readBaselineRun = (records) => {
  const [record] = records ?? [];
  const runId = String(record?.fields?.["Run ID"] ?? "").trim();
  if (!runId) {
    return undefined;
  }
  // `Number(null)` is 0, and a run attempt is never 0 — filtering on it would
  // match nothing and report the released run as having no results.
  const runAttempt = Number(record.fields["Run Attempt"]);
  return {
    runId,
    runAttempt: Number.isFinite(runAttempt) && runAttempt >= 1 ? runAttempt : 1,
    finishedAt: record.fields["Finished At"] ?? undefined,
  };
};

export const buildBaselineResultsQuery = ({
  runId,
  runAttempt,
  skip = 0,
  take = BASELINE_RESULTS_PAGE_SIZE,
}) => {
  if (!runId) {
    throw new Error("A baseline run id is required to read its results.");
  }
  return searchParams([
    ["fieldKeyType", "name"],
    ["take", take],
    ["skip", skip],
    ["projection", "Case ID"],
    ["projection", "Engine"],
    ["projection", "Result"],
    ["projection", "Primary Metric"],
    ["projection", "Primary Metric Value"],
    [
      "filter",
      JSON.stringify({
        conjunction: "and",
        filterSet: [
          { fieldId: "Run ID", operator: "is", value: runId },
          { fieldId: "Run Attempt", operator: "is", value: runAttempt },
        ],
      }),
    ],
  ]);
};

/**
 * Fold baseline records into the artifact the summary reads.
 *
 * Only passing measurements become baseline values. A case that failed in the
 * released run has a number, but it is the duration of a failure, not of the
 * released behaviour; comparing against it invents a regression or hides one.
 */
export const buildReleaseBaseline = ({ launch, run, records, runUrl }) => {
  const values = {};
  let skipped = 0;

  for (const record of records ?? []) {
    const fields = record?.fields ?? {};
    const caseId = String(fields["Case ID"] ?? "").trim();
    const engine = String(fields.Engine ?? "").trim();
    const value = Number(fields["Primary Metric Value"]);

    if (!caseId || !engine) {
      continue;
    }
    if (fields.Result !== "pass" || !Number.isFinite(value) || value <= 0) {
      skipped += 1;
      continue;
    }

    values[`${caseId}::${engine}`] = {
      value,
      metric: String(fields["Primary Metric"] ?? "").trim() || undefined,
    };
  }

  return {
    commit: launch?.commit,
    release: launch?.release,
    runId: run?.runId,
    runAttempt: run?.runAttempt,
    finishedAt: run?.finishedAt,
    runUrl,
    caseCount: new Set(
      Object.keys(values).map((key) => key.slice(0, key.lastIndexOf("::"))),
    ).size,
    valueCount: Object.keys(values).length,
    unusableCount: skipped,
    values,
  };
};
