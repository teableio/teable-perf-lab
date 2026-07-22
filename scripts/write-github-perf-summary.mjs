import { appendFile } from "node:fs/promises";
import { readArtifactPayloads } from "./perf-artifact-read-model.mjs";
import {
  buildPerfSummaryMarkdown,
  DEFAULT_GITHUB_SUMMARY_MAX_BYTES,
} from "./perf-run-summary-model.mjs";

const DEFAULT_CHART_URL = "https://ppm.teable.app";
const DEFAULT_TEABLE_RESULTS_URL =
  "https://app.teable.ai/base/bselS3I2MeVI6RJhS4g/table/tblwPqrcchUzvyEOqLo/viwobw44IRJAHgtADI0";

const env = (name, fallback = "") => process.env[name] ?? fallback;

const requiredEnv = (name) => {
  const value = env(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
};

const buildRunUrl = () => {
  const repository = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  return repository && runId
    ? `https://github.com/${repository}/actions/runs/${runId}`
    : "";
};

const main = async () => {
  const artifactDir = requiredEnv("PERF_LAB_ARTIFACT_DIR");
  const summaryPath = requiredEnv("GITHUB_STEP_SUMMARY");
  let entries;
  try {
    entries = await readArtifactPayloads({
      artifactDir,
      includeSeed: false,
      allowEmpty: true,
    });
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    entries = [];
  }
  const payloads = entries
    .map(({ payload }) => payload)
    .sort((a, b) =>
      `${a.caseId}:${a.engine}`.localeCompare(`${b.caseId}:${b.engine}`),
    );

  if (payloads.length === 0) {
    await appendFile(summaryPath, "No combined perf summary was generated.\n");
    return;
  }

  const configuredMaxBytes = Number(
    env("PERF_LAB_GITHUB_SUMMARY_MAX_BYTES", DEFAULT_GITHUB_SUMMARY_MAX_BYTES),
  );
  const markdown = buildPerfSummaryMarkdown({
    payloads,
    maxBytes: configuredMaxBytes,
    context: {
      chartUrl: env("PERF_LAB_CHART_URL", DEFAULT_CHART_URL),
      executeResult: env("PERF_LAB_JOB_RESULT"),
      runId: env("GITHUB_RUN_ID", payloads[0]?.runId ?? ""),
      runUrl: buildRunUrl(),
      sha: env("PERF_LAB_TEABLE_EE_SHA") || env("GITHUB_SHA", "").slice(0, 7),
      teableRef: env("PERF_LAB_TEABLE_EE_REF") || env("GITHUB_REF_NAME"),
      teableResultsUrl: env(
        "PERF_LAB_TEABLE_RESULTS_URL",
        DEFAULT_TEABLE_RESULTS_URL,
      ),
    },
  });
  await appendFile(summaryPath, `${markdown}\n`);
  console.log(
    `GitHub perf summary wrote ${Buffer.byteLength(markdown, "utf8")} bytes from ${payloads.length} payloads.`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
