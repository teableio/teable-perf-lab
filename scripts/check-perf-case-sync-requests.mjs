import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCaseFilesOnDisk } from "./case-catalog.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const expectedCaseCount = (await findCaseFilesOnDisk(repoRoot)).length;
const requiredFieldNames = [
  "Case ID",
  "Title",
  "Owner",
  "Tags",
  "Enabled",
  "Runner",
  "Primary Metric",
  "Primary Threshold Ms",
  "Timeout Ms",
  "Case Path",
  "Description Path",
  "Description URL",
  "CI Reproduce Command",
  "Local Reproduce Command",
  "Source SHA",
  "Synced At",
];
const storedRecords = [];
const requests = [];

const readJson = async (request) => {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
  }
  return body ? JSON.parse(body) : undefined;
};

const respondJson = (response, status, value) => {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    const entry = { method: request.method, path: url.pathname };
    requests.push(entry);

    if (request.method === "GET" && url.pathname.endsWith("/field")) {
      respondJson(
        response,
        200,
        requiredFieldNames.map((name, index) => ({ id: `fld-${index}`, name })),
      );
      return;
    }

    if (request.method === "GET" && url.pathname.endsWith("/record")) {
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const take = Number(url.searchParams.get("take") ?? 100);
      entry.skip = skip;
      entry.take = take;
      respondJson(response, 200, {
        records: storedRecords.slice(skip, skip + take),
      });
      return;
    }

    if (request.method === "PATCH" && url.pathname.endsWith("/record")) {
      const body = await readJson(request);
      entry.recordCount = body.records.length;
      for (const update of body.records) {
        const stored = storedRecords.find((record) => record.id === update.id);
        assert.ok(stored, `Unknown record id ${update.id}`);
        stored.fields = { ...stored.fields, ...update.fields };
      }
      respondJson(response, 200, []);
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/record")) {
      const body = await readJson(request);
      entry.recordCount = body.records.length;
      const created = body.records.map((record, index) => ({
        id: `rec-${storedRecords.length + index + 1}`,
        fields: { ...record.fields },
      }));
      storedRecords.push(...created);
      respondJson(response, 200, { records: created });
      return;
    }

    respondJson(response, 404, {
      message: `${request.method} ${url.pathname}`,
    });
  } catch (error) {
    respondJson(response, 500, {
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

const runSync = async (endpoint) => {
  const child = spawn(process.execPath, ["scripts/sync-perf-cases.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PERF_LAB_CASE_SYNC_DRY_RUN: "",
      TEABLE_ENDPOINT: endpoint,
      TEABLE_PERF_LAB_TOKEN: "test-token",
      TEABLE_PERF_LAB_BASE_ID: "test-base",
      TEABLE_PERF_CASES_TABLE_ID: "test-table",
      GITHUB_REPOSITORY: "teableio/teable-perf-lab",
      GITHUB_SHA: "test-sha",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(exitCode, 0, stderr);
  return stdout;
};

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  const firstStart = requests.length;
  const firstOutput = await runSync(endpoint);
  const firstRequests = requests.slice(firstStart);
  assert.match(
    firstOutput,
    new RegExp(
      `Perf case sync summary: created=${expectedCaseCount}, updated=0, unchanged=0`,
    ),
  );
  assert.deepEqual(
    firstRequests.map(({ method, recordCount }) => [method, recordCount]),
    [
      ["GET", undefined],
      ["GET", undefined],
      ["POST", expectedCaseCount],
    ],
  );
  assert.equal(firstRequests[1].take, 1000);
  assert.equal(firstRequests[1].skip, 0);

  const secondStart = requests.length;
  const secondOutput = await runSync(endpoint);
  const secondRequests = requests.slice(secondStart);
  assert.match(
    secondOutput,
    new RegExp(
      `Perf case sync summary: created=0, updated=0, unchanged=${expectedCaseCount}`,
    ),
  );
  assert.deepEqual(
    secondRequests.map(({ method }) => method),
    ["GET", "GET"],
    "an unchanged registry must not issue write requests",
  );

  storedRecords[0].fields.Title = "stale title";
  const thirdStart = requests.length;
  const thirdOutput = await runSync(endpoint);
  const thirdRequests = requests.slice(thirdStart);
  assert.match(
    thirdOutput,
    new RegExp(
      `Perf case sync summary: created=0, updated=1, unchanged=${expectedCaseCount - 1}`,
    ),
  );
  assert.deepEqual(
    thirdRequests.map(({ method, recordCount }) => [method, recordCount]),
    [
      ["GET", undefined],
      ["GET", undefined],
      ["PATCH", 1],
    ],
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("Perf case sync request checks passed.");
