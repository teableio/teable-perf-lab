import { readFile } from "node:fs/promises";

// The case registry sync has no result artifacts and no perf summary, so without
// this card a failed sync is visible only to someone reading the Actions tab.

const env = (name) => process.env[name]?.trim() ?? "";

const readFailureLine = async (path) => {
  if (!path) return "";
  const log = await readFile(path, "utf8").catch(() => "");
  const line = log.split("\n").find((entry) => entry.startsWith("Error:"));
  return (line ?? "").slice(0, 500);
};

const buildCard = ({ failure, repository, runId, sha, actor }) => ({
  msg_type: "interactive",
  card: {
    config: { wide_screen_mode: true },
    header: {
      template: "red",
      title: { tag: "plain_text", content: "❌ 性能用例同步到 Teable 失败" },
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            `**仓库** ${repository}`,
            `**提交** ${sha.slice(0, 8)}${actor ? ` · ${actor}` : ""}`,
            `**运行** [${runId}](https://github.com/${repository}/actions/runs/${runId})`,
            failure ? `**错误** ${failure}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      },
    ],
  },
});

const main = async () => {
  const webhookUrl = env("FEISHU_PERF_WEBHOOK_URL");
  if (!webhookUrl) {
    throw new Error("FEISHU_PERF_WEBHOOK_URL is not set.");
  }
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(
      buildCard({
        failure: await readFailureLine(env("PERF_LAB_SYNC_LOG")),
        repository: env("GITHUB_REPOSITORY"),
        runId: env("GITHUB_RUN_ID"),
        sha: env("GITHUB_SHA"),
        actor: env("GITHUB_ACTOR"),
      }),
    ),
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok || (data?.code !== 0 && data?.StatusCode !== 0)) {
    throw new Error(
      `Feishu rejected the sync failure card: ${response.status} ${JSON.stringify(data)}`,
    );
  }
  console.log("Feishu sync failure card sent.");
};

await main();
