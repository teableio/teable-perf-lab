// Push the confirmed change points to Feishu, as the night's second card.
//
// Runs after `run-shadow-analysis.mjs`, reads the same `shadow-analysis.json`
// the artifact carries, and pushes only when there is a V2 slowdown nobody has
// been told about. `change-point-card-model.mjs` holds that rule; this file is
// the environment and the webhook.
//
// It exits zero on every path it can reason about, including a missing result:
// the analysis ahead of it is allowed to fail, and a delivery step that fails
// louder than the thing it delivers turns one broken shadow run into a red
// report job. What it will not do is fail quietly — every path prints why.

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "./env.mjs";
import { buildChangePointCard, describeDelivery } from "./change-point-card-model.mjs";
import { SHADOW_RESULT_FILE_NAME } from "./run-shadow-analysis.mjs";

const DEFAULT_CHART_URL = "https://ppm.teable.app";
const DEFAULT_TEABLE_RESULTS_URL =
  "https://app.teable.ai/base/bselS3I2MeVI6RJhS4g/table/tblwPqrcchUzvyEOqLo/viwobw44IRJAHgtADI0";

const buildRunUrl = () => {
  const repository = env("GITHUB_REPOSITORY");
  const runId = env("GITHUB_RUN_ID");
  if (!repository || !runId) {
    return "";
  }
  return `https://github.com/${repository}/actions/runs/${runId}`;
};

const sendFeishuCard = async (webhookUrl, card) => {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(card),
  });

  if (!res.ok) {
    throw new Error(`Feishu webhook failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  if (data?.code !== 0 && data?.StatusCode !== 0) {
    throw new Error(`Feishu webhook rejected the card: ${JSON.stringify(data)}`);
  }
};

const main = async () => {
  const resultPath = resolve(
    env("SHADOW_RESULT_PATH", SHADOW_RESULT_FILE_NAME),
  );

  let result;
  try {
    result = JSON.parse(await readFile(resultPath, "utf8"));
  } catch {
    // Tolerated, and stated. The analysis step already writes its own warning
    // when it produces nothing, and repeating that as a failure here would
    // report one problem twice under two names.
    console.log(
      `Change point card: no ${resultPath}; the shadow analysis produced nothing this run. Nothing to push.`,
    );
    return;
  }

  const decision = describeDelivery({ result });
  console.log(`Change point card: ${decision.reason}`);
  if (isColdStartWarningWanted(result, decision)) {
    console.log(
      `::warning title=Change point card suppressed on a cold start::${decision.reason}`,
    );
  }

  const card = buildChangePointCard({
    result,
    context: {
      chartUrl: env("PERF_LAB_CHART_URL", DEFAULT_CHART_URL),
      runUrl: buildRunUrl(),
      teableRef: result.teableEeRef || env("PERF_LAB_TEABLE_EE_REF"),
      teableResultsUrl: env(
        "PERF_LAB_TEABLE_RESULTS_URL",
        DEFAULT_TEABLE_RESULTS_URL,
      ),
    },
  });
  if (!card) {
    return;
  }

  if (env("FEISHU_PERF_DRY_RUN") === "true") {
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  const webhookUrl = env("FEISHU_PERF_WEBHOOK_URL");
  if (!webhookUrl) {
    console.warn(
      "FEISHU_PERF_WEBHOOK_URL is not set; skipping the change point card.",
    );
    return;
  }

  await sendFeishuCard(webhookUrl, card);
  console.log("Change point card sent.");
};

// A quiet night needs no annotation; a lost seen-set does. The distinction is
// worth a named function because both of them reach this code as "did not
// send", and only one of them means something is broken upstream.
const isColdStartWarningWanted = (result, decision) =>
  !decision.send && (result?.seenBefore ?? 0) === 0;

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
