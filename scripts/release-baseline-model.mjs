// Request shapes and parsing for the released-build baseline.
//
// Two tables, two tokens, two reads: the Launches table (`TEABLE_LAUNCHES_TOKEN`,
// read only, a different base) names the commit currently deployed, and one
// query against Performance Track (`TEABLE_PERF_LAB_TOKEN`) returns every row
// that commit produced. Keep fetch/filesystem work in
// `resolve-release-baseline.mjs`.
//
// There is deliberately no separate "which run measured this commit" lookup.
// `filter` cannot express "the newest run", so resolving it server-side takes an
// `orderBy` + `take 1` round trip whose only output — the run id — is already a
// column on every row of the read that follows. Pulling the commit's rows and
// picking the newest run locally drops that round trip, drops the `orderBy` (see
// below), and keeps run identity and results from ever disagreeing. The cost is
// the rows of any earlier run of the same commit: 500 of 545 commits have been
// measured exactly once, and the widest observed is 10 runs / 6,462 rows.
//
// Nothing here sorts server-side. A `filter` or `orderBy` naming a field that
// does not exist is not rejected — the condition is silently dropped. A renamed
// sort field returns an arbitrary row; a renamed filter field returns the whole
// table (129,850 rows against the 540 wanted). Filters below address columns by
// id for that reason, as the launch query already did: an id survives a rename,
// a name does not.
//
// Every query here is bounded on purpose. The Performance Track rows carry
// Metrics/Phases/Trace-Manifest JSON and Summary Markdown, so an unprojected
// read of 100 rows is 2.5 MB and the API rejects it outright; the projections
// below name only the columns the summary actually reads, and the launch lookup
// is one record in under 500 bytes.

import { readComputeBaseline } from "./compute-comparison-model.mjs";

// `Metrics JSON` is a text column holding a serialized object, so anything can be
// in it: an older schema, a truncated write, or nothing at all. A baseline row is
// not worth failing a run over — an unreadable blob costs the compute half of one
// case's comparison, which the comparison already renders as "no baseline".
const parseMetrics = (value) => {
  if (value && typeof value === "object") {
    return value;
  }
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
};

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

// Filter by id for the same reason the launch query does. Renaming the column
// would not fail the request, it would drop the condition and return the table.
export const TEABLE_EE_REF_FIELD_ID = "fldu6jMFL0NmJ5GzEmU";

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

/**
 * Every Performance Track row the released commit produced, one page at a time.
 *
 * The projection is the summary's whole appetite and nothing else: `Run ID` and
 * `Run Attempt` identify the run, `Case ID`/`Engine` key the value, `Result`
 * decides whether it is usable, `Primary Metric` guards against comparing across
 * a renamed metric, and `Primary Metric Value` is the number. `Finished At` is
 * deliberately absent — nothing renders it, and picking the newest run reads run
 * ids, which GitHub issues in increasing order.
 *
 * `Metrics JSON` is the one heavy column here, and it is pulled because compute
 * time has no column of its own — it rides inside that blob with every other
 * metric. Measured at 689 bytes per row against the ~25 KB/row that made an
 * unprojected read fail outright, so a 1000-row page costs about 672 KB and a
 * full run's ~530 rows about 360 KB. If compute time ever earns its own column,
 * drop this projection rather than keeping both.
 */
export const buildBaselineRecordsQuery = ({
  commit,
  skip = 0,
  take = BASELINE_RESULTS_PAGE_SIZE,
}) => {
  if (!commit) {
    throw new Error("A release commit is required to read its baseline.");
  }
  return searchParams([
    ["fieldKeyType", "name"],
    ["take", take],
    ["skip", skip],
    ["projection", "Run ID"],
    ["projection", "Run Attempt"],
    ["projection", "Case ID"],
    ["projection", "Engine"],
    ["projection", "Result"],
    ["projection", "Primary Metric"],
    ["projection", "Primary Metric Value"],
    ["projection", "Metrics JSON"],
    [
      "filter",
      JSON.stringify({
        conjunction: "and",
        filterSet: [
          { fieldId: TEABLE_EE_REF_FIELD_ID, operator: "is", value: commit },
        ],
      }),
    ],
  ]);
};

const readRun = (record) => {
  const runId = String(record?.fields?.["Run ID"] ?? "").trim();
  if (!runId) {
    return undefined;
  }
  // `Number(null)` is 0, and a run attempt is never 0 — treated as a distinct
  // attempt it would split one run in two and take half its results as the
  // baseline.
  const runAttempt = Number(record.fields["Run Attempt"]);
  return {
    runId,
    runAttempt: Number.isFinite(runAttempt) && runAttempt >= 1 ? runAttempt : 1,
  };
};

// GitHub issues run ids in increasing order, so the larger id is the later run.
// They arrive as text and compare as numbers; a non-numeric id (a local run)
// falls back to string order rather than making every comparison NaN.
const isLaterRun = (run, than) => {
  const left = Number(run.runId);
  const right = Number(than.runId);
  if (Number.isFinite(left) && Number.isFinite(right) && left !== right) {
    return left > right;
  }
  if (run.runId !== than.runId) {
    return run.runId > than.runId;
  }
  return run.runAttempt > than.runAttempt;
};

/**
 * Pick the run whose results become the baseline.
 *
 * A commit is usually measured once and this is the only run present. When it
 * was measured more than once — a rerun, a repeated dispatch — the latest
 * attempt is the one that describes the released build now.
 *
 * `excludeRunId` is the run being reported, and it has to be excluded rather
 * than merely tie-broken. Its own rows are already in Performance Track by the
 * time the baseline is resolved — `report-teable-result.mjs` writes them one
 * step earlier — so whenever a run measures the commit that is currently
 * released, the newest run for that commit is itself. Run 31328413335 did
 * exactly that on 2026-08-09 and reported `269 compared · 0 slower · 0 faster ·
 * 0 without baseline`, which is not a clean run but a run compared against a
 * copy of itself: every ratio was exactly 1.0. That reads identically to a
 * release nothing regressed against, which is the whole reason it has to be
 * impossible rather than unlikely.
 *
 * Excluded by run id alone, not by id and attempt. A rerun of this run is still
 * this run, and its earlier attempt measured the same build on the same
 * machine — comparing against it would answer a different question than "how
 * does this build compare with the released one".
 */
export const selectBaselineRun = (records, { excludeRunId } = {}) => {
  const excluded = String(excludeRunId ?? "").trim();
  let latest;
  for (const record of records ?? []) {
    const run = readRun(record);
    if (!run || (excluded && run.runId === excluded)) {
      continue;
    }
    if (!latest || isLaterRun(run, latest)) {
      latest = run;
    }
  }
  return latest;
};

/**
 * Fold one run's records into the artifact the summary reads.
 *
 * `records` holds every run of the released commit, so rows from an earlier run
 * are dropped here rather than in a query — they are neither baseline values nor
 * unusable measurements, they belong to a different run entirely.
 *
 * Only passing measurements become baseline values. A case that failed in the
 * released run has a number, but it is the duration of a failure, not of the
 * released behaviour; comparing against it invents a regression or hides one.
 */
export const buildReleaseBaseline = ({ launch, run, records, runUrl }) => {
  const values = {};
  let skipped = 0;
  // Two ways to get zero compute baselines, and they need telling apart: rows
  // written before compute collection shipped parse fine and simply have no
  // `computeMs`, while a `Metrics JSON` this code cannot read at all — a changed
  // cell format, a renamed column returning nothing — produces the identical
  // zero. Without this counter the second failure is invisible, and "no compute
  // baseline yet" is a legitimate state that would hide it indefinitely.
  let metricsReadable = 0;
  let metricsUnreadable = 0;

  for (const record of records ?? []) {
    const fields = record?.fields ?? {};
    const caseId = String(fields["Case ID"] ?? "").trim();
    const engine = String(fields.Engine ?? "").trim();
    const value = Number(fields["Primary Metric Value"]);

    const rowRun = readRun(record);
    if (
      run &&
      (!rowRun ||
        rowRun.runId !== run.runId ||
        rowRun.runAttempt !== run.runAttempt)
    ) {
      continue;
    }

    if (!caseId || !engine) {
      continue;
    }
    if (fields.Result !== "pass" || !Number.isFinite(value) || value <= 0) {
      skipped += 1;
      continue;
    }

    const entry = {
      value,
      metric: String(fields["Primary Metric"] ?? "").trim() || undefined,
    };

    // Absent rather than undefined: this object is written as JSON, where an
    // undefined value drops the key anyway, so setting it only when there is one
    // keeps the in-memory entry and the file on disk the same shape. Every row
    // measured before compute collection shipped lands here, and the comparison
    // reads a missing key as "no baseline" rather than as zero.
    const rawMetrics = fields["Metrics JSON"];
    const metrics = parseMetrics(rawMetrics);
    if (metrics) {
      metricsReadable += 1;
    } else if (rawMetrics !== undefined && rawMetrics !== null) {
      metricsUnreadable += 1;
    }

    const compute = readComputeBaseline(metrics);
    if (compute) {
      entry.compute = compute;
    }

    values[`${caseId}::${engine}`] = entry;
  }

  return {
    commit: launch?.commit,
    release: launch?.release,
    runId: run?.runId,
    runAttempt: run?.runAttempt,
    runUrl,
    caseCount: new Set(
      Object.keys(values).map((key) => key.slice(0, key.lastIndexOf("::"))),
    ).size,
    valueCount: Object.keys(values).length,
    unusableCount: skipped,
    computeCount: Object.values(values).filter((entry) => entry.compute).length,
    metricsReadable,
    metricsUnreadable,
    values,
  };
};
