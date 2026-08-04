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

  const records = await readBaselineRecords({
    endpoint,
    token: perfToken,
    tableId: performanceTrackTableId,
    commit: launch.commit,
  });

  const run = selectBaselineRun(records);
  if (!run) {
    console.warn(
      `Release ${launch.release ?? launch.commit} has no recorded perf run; no release baseline. Dispatch the workflow with teable_ee_ref=${launch.commit} to create one.`,
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
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
