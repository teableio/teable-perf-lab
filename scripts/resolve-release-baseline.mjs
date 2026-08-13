// Resolve the released build's measurements into `release-baseline.json`.
//
// Runs once per report job, before the Feishu card and the GitHub summary, so
// both read the same numbers from disk instead of querying Teable twice.
//
// Missing credentials are not a failure. The summary renders an explicit "no
// baseline" state, which is the honest reading — silently reporting zero
// regressions would look like a clean run.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { env, requiredEnv } from "./env.mjs";
import {
  BASELINE_RESULTS_PAGE_SIZE,
  buildBaselineRecordsQuery,
  buildLatestLaunchQuery,
  buildReleaseBaseline,
  DEFAULT_LAUNCH_REGION,
  LAUNCHES_TABLE_ID,
  readLatestLaunch,
  RELEASE_BASELINE_FILE_NAME,
  selectBaselineRun,
} from "./release-baseline-model.mjs";

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_PERFORMANCE_TRACK_TABLE_ID = "tblwPqrcchUzvyEOqLo";

const teableRecords = async ({ endpoint, token, tableId, params }) => {
  const res = await fetch(
    `${endpoint.replace(/\/+$/, "")}/api/table/${tableId}/record?${params.toString()}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
    },
  );

  if (!res.ok) {
    throw new Error(
      `Teable GET /table/${tableId}/record failed: ${res.status} ${await res.text()}`,
    );
  }

  const data = await res.json();
  return data?.records ?? [];
};

// Every row the released commit produced, across however many runs measured it.
const readBaselineRecords = async ({ endpoint, token, tableId, commit }) => {
  const records = [];
  for (let skip = 0; ; skip += BASELINE_RESULTS_PAGE_SIZE) {
    const page = await teableRecords({
      endpoint,
      token,
      tableId,
      params: buildBaselineRecordsQuery({ commit, skip }),
    });
    records.push(...page);
    if (page.length < BASELINE_RESULTS_PAGE_SIZE) {
      return records;
    }
  }
};

const buildRunUrl = (runId) => {
  const repository = env("GITHUB_REPOSITORY");
  return repository && runId
    ? `https://github.com/${repository}/actions/runs/${runId}`
    : undefined;
};

const main = async () => {
  const artifactDir = requiredEnv("PERF_LAB_ARTIFACT_DIR");
  const outputPath = join(artifactDir, RELEASE_BASELINE_FILE_NAME);
  const launchesToken = env("TEABLE_LAUNCHES_TOKEN");
  const perfToken = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");

  if (!launchesToken || !perfToken) {
    console.warn(
      `${!launchesToken ? "TEABLE_LAUNCHES_TOKEN" : "TEABLE_PERF_LAB_TOKEN"} is not set; skipping release baseline.`,
    );
    return;
  }

  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const launchesTableId = env("TEABLE_LAUNCHES_TABLE_ID", LAUNCHES_TABLE_ID);
  const performanceTrackTableId = env(
    "TEABLE_PERF_LAB_TABLE_ID",
    DEFAULT_PERFORMANCE_TRACK_TABLE_ID,
  );
  const region = env("PERF_LAB_LAUNCH_REGION", DEFAULT_LAUNCH_REGION);

  const launch = readLatestLaunch(
    await teableRecords({
      endpoint,
      token: launchesToken,
      tableId: launchesTableId,
      params: buildLatestLaunchQuery({ region }),
    }),
  );
  if (!launch) {
    console.warn(
      `No launch recorded for region ${region}; no release baseline.`,
    );
    return;
  }

  // This run is testing the build that is already released, so there is no
  // comparison to make. An earlier run of the same commit differs from this one
  // by run-to-run noise and by nothing else, and that noise — 13.6% mean
  // per-case on the wall clock, against a 20% band — lands cases in the `>1.2x`
  // column for no reason anyone can act on.
  //
  // An artifact is still written, carrying `sameCommit` and no values. Three
  // states have to stay distinguishable and only one of them is a problem:
  // "this run is the release", "nobody has measured the release", and "the file
  // was never written at all". Skipping the write would merge the first two
  // into the third. It also skips the 540-row read below, which nothing would
  // have used.
  //
  // The same three states have to survive into the log, and until 2026-08-13
  // they did not. This path returns before the `Compute baseline:` line below,
  // so a run that measured the released commit said nothing about compute at
  // all — and grepping a full run's log for exactly that line is the documented
  // way to check whether the compute baseline has filled in. On a night when the
  // scheduled run lands on the released commit, common right after a release,
  // that check silently has no answer and "absent" reads the same as "the step
  // never ran". Hence the second line below. It cannot report counts, because
  // nothing was read, and saying `0 readable` here would be the one reading that
  // means the column broke.
  const currentRef = env("PERF_LAB_TEABLE_EE_REF");
  if (currentRef && currentRef === launch.commit) {
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          commit: launch.commit,
          release: launch.release,
          sameCommit: true,
          caseCount: 0,
          valueCount: 0,
          unusableCount: 0,
          computeCount: 0,
          metricsReadable: 0,
          metricsUnreadable: 0,
          values: {},
        },
        null,
        2,
      )}\n`,
    );
    console.log(
      `Release baseline: this run measures the released commit itself (${launch.release ?? launch.commit}, ${launch.commit.slice(0, 7)}); no release comparison → ${outputPath}`,
    );
    console.log(
      "Compute baseline: not evaluated — this run is the release, so no baseline rows were read. " +
        "Not the same as 0 readable, which would mean the Metrics JSON column can no longer be parsed.",
    );
    return;
  }

  const records = await readBaselineRecords({
    endpoint,
    token: perfToken,
    tableId: performanceTrackTableId,
    commit: launch.commit,
  });

  // This run's own rows are already in Performance Track — they were written a
  // step ago — so a run measuring the released commit would otherwise pick
  // itself and compare against a copy of itself. The `sameCommit` check above
  // catches that case first when the ref is known; this stays as the guard for
  // when it is not.
  const currentRunId = env("GITHUB_RUN_ID");
  const run = selectBaselineRun(records, { excludeRunId: currentRunId });
  if (!run) {
    // "Nobody has measured it" and "only this run has" want different answers:
    // the first is fixed by dispatching, the second fixes itself on the next
    // run and dispatching again would only add a second self.
    const measuredOnlyByThisRun = records.length > 0;
    console.warn(
      measuredOnlyByThisRun
        ? `Release ${launch.release ?? launch.commit} has been measured only by this run (${currentRunId}); no release baseline. This run is testing the released commit, so there is nothing earlier to compare against — the next run against a newer commit will have one.`
        : `Release ${launch.release ?? launch.commit} has no recorded perf run; no release baseline. Dispatch the workflow with teable_ee_ref=${launch.commit} to create one.`,
    );
    return;
  }

  const baseline = buildReleaseBaseline({
    launch,
    run,
    runUrl: buildRunUrl(run.runId),
    records,
  });

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(
    `Release baseline: ${launch.release ?? launch.commit} (${launch.commit.slice(0, 7)}) run ${run.runId} attempt ${run.runAttempt}, ${baseline.caseCount} cases / ${baseline.valueCount} measurements${baseline.unusableCount > 0 ? `, ${baseline.unusableCount} unusable` : ""}, ${records.length} rows read → ${outputPath}`,
  );
  console.log(
    `Compute baseline: ${baseline.computeCount} values, metrics ${baseline.metricsReadable} readable / ${baseline.metricsUnreadable} unreadable`,
  );
  // Zero compute is expected until a released commit has been measured since
  // compute collection shipped. Zero *readable* metrics is not: it means this
  // code can no longer read the column it reads compute out of, which otherwise
  // looks exactly the same from here.
  if (records.length > 0 && baseline.metricsReadable === 0) {
    console.warn(
      `[perf-lab] read ${records.length} baseline rows and could not parse Metrics JSON on any of them. ` +
        `The column's name or cell format changed; compute comparison is silently disabled until this is fixed.`,
    );
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
