import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  fileExists,
  readSeedCacheStatuses,
  readTraceManifests,
} from "./perf-artifact-read-model.mjs";
import {
  observeStagePlan,
  renderStagePlanObservationMarkdown,
  resolveTraceJobIdentity,
  summarizeSeedCacheStatuses,
} from "./stage-plan-observation-model.mjs";

const env = (name, fallback = "") => process.env[name] ?? fallback;

const requiredEnv = (name) => {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const githubApi = async (path) => {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${requiredEnv("GITHUB_TOKEN")}`,
      "x-github-api-version": "2022-11-28",
    },
  });
  if (!response.ok) {
    throw new Error(
      `GitHub API ${path} failed: ${response.status} ${await response.text()}`,
    );
  }
  return response.json();
};

const loadCurrentAttemptJobs = async () => {
  const repository = requiredEnv("GITHUB_REPOSITORY");
  const runId = requiredEnv("GITHUB_RUN_ID");
  const attempt = Number(env("GITHUB_RUN_ATTEMPT", "1"));
  const jobs = [];
  for (let page = 1; ; page += 1) {
    const response = await githubApi(
      `/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=${page}`,
    );
    const pageJobs = Array.isArray(response.jobs) ? response.jobs : [];
    jobs.push(
      ...pageJobs.filter(
        (job) => job.run_attempt == null || job.run_attempt === attempt,
      ),
    );
    if (pageJobs.length < 100) {
      break;
    }
  }
  return jobs;
};

const loadTraceObservation = async (artifactDir, executionProfile) => {
  const manifests = await readTraceManifests({ artifactDir });
  if (manifests.length === 0) {
    return null;
  }
  let maximum = {
    durationMs: 0,
    shard: "none",
    source: "no trace wait observed",
  };
  const waitsByJob = new Map();
  for (const { manifest, fileName } of manifests) {
    const durationMs = Number(
      manifest.traceFetchJobWaitMs ?? manifest.traceFetchWaitMs ?? 0,
    );
    if (!Number.isFinite(durationMs)) {
      continue;
    }
    const traceJob = resolveTraceJobIdentity(fileName, executionProfile);
    const shard = traceJob?.shard ?? "unknown";
    if (durationMs >= maximum.durationMs) {
      maximum = {
        durationMs,
        shard,
        source: `trace manifest ${fileName}`,
      };
    }
    if (traceJob) {
      const key = `${traceJob.stage}:${traceJob.shard}`;
      const current = waitsByJob.get(key);
      if (!current || durationMs > current.durationMs) {
        waitsByJob.set(key, { ...traceJob, durationMs });
      }
    }
  }
  return { ...maximum, jobWaits: [...waitsByJob.values()] };
};

const loadSeedCacheObservation = async (artifactDir) => {
  if (!artifactDir || !(await fileExists(artifactDir))) {
    return summarizeSeedCacheStatuses([]);
  }
  const statuses = await readSeedCacheStatuses({ artifactDir });
  return summarizeSeedCacheStatuses(statuses.map(({ status }) => status));
};

const main = async () => {
  const planSummary = JSON.parse(requiredEnv("PERF_LAB_PLAN_SUMMARY"));
  if (!planSummary.stagePlan) {
    console.log("No full-run stage plan; skipping current-run observation.");
    return;
  }
  const artifactDir = requiredEnv("PERF_LAB_ARTIFACT_DIR");
  const executionProfile = planSummary.stagePlan.executionProfile;
  const observation = observeStagePlan({
    planSummary,
    jobs: await loadCurrentAttemptJobs(),
    traceObservation: await loadTraceObservation(
      artifactDir,
      executionProfile,
    ),
    seedCacheObservation: await loadSeedCacheObservation(
      env("PERF_LAB_SEED_ARTIFACT_DIR"),
    ),
    sourceRunId: requiredEnv("GITHUB_RUN_ID"),
  });
  const outputPath = requiredEnv("PERF_LAB_PLAN_OBSERVATION_PATH");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(observation, null, 2)}\n`,
    "utf8",
  );
  const markdown = renderStagePlanObservationMarkdown(observation);
  const summaryPath = env("GITHUB_STEP_SUMMARY");
  if (summaryPath) {
    await appendFile(summaryPath, `\n${markdown}`, "utf8");
  }
  console.log(markdown.trimEnd());
  console.log(`Wrote stage-plan observation to ${outputPath}.`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
