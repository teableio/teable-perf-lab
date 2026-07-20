import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PERFORMANCE_TRACK_CONTRACT_FIELDS } from "./performance-track-contract.fixture.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const artifactDir = await mkdtemp(join(tmpdir(), "perf-report-requests-"));
const storedRecords = [];
const requests = [];

const readJson = async (request) => {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  return body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined;
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
      respondJson(response, 200, PERFORMANCE_TRACK_CONTRACT_FIELDS);
      return;
    }

    if (request.method === "GET" && url.pathname.endsWith("/record")) {
      const filter = JSON.parse(url.searchParams.get("filter") ?? "{}");
      const skip = Number(url.searchParams.get("skip") ?? 0);
      const take = Number(url.searchParams.get("take") ?? 100);
      entry.skip = skip;
      entry.take = take;
      entry.filter = filter;
      const matches = storedRecords.filter((record) =>
        (filter.filterSet ?? []).every(
          (condition) =>
            record.fields?.[condition.fieldId] === condition.value,
        ),
      );
      respondJson(response, 200, {
        records: matches.slice(skip, skip + take),
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

const writeArtifacts = async () => {
  for (const engine of ["v1", "v2"]) {
    const directory = join(
      artifactDir,
      `teable-ee-e2e-perf-results-${engine}-123-1`,
    );
    await mkdir(directory, { recursive: true });
    for (let index = 1; index <= 3; index += 1) {
      const caseId = `report/case-${index}`;
      const payload = {
        caseId,
        title: `Report case ${index}`,
        runId: `123-1-${engine}`,
        engine,
        result: "pass",
        startedAt: "2026-07-20T00:00:00.000Z",
        finishedAt: "2026-07-20T00:00:01.000Z",
        durationMs: 1_000,
        metrics: { readyMs: 900 },
        thresholds: [
          { metric: "readyMs", actual: 900, max: 2_000, passed: true },
        ],
        phases: [{ name: "ready", durationMs: 900 }],
      };
      await writeFile(
        join(directory, `report-case-${index}-${engine}.json`),
        JSON.stringify(payload),
      );
    }
  }
};

const runReport = async (endpoint) => {
  const child = spawn(process.execPath, ["scripts/report-teable-result.mjs"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      TEABLE_ENDPOINT: endpoint,
      TEABLE_PERF_LAB_TOKEN: "test-token",
      TEABLE_PERF_LAB_BASE_ID: "test-base",
      TEABLE_PERF_LAB_TABLE_ID: "test-table",
      PERF_LAB_ARTIFACT_DIR: artifactDir,
      GITHUB_REPOSITORY: "",
      GITHUB_RUN_ID: "123",
      GITHUB_RUN_ATTEMPT: "1",
      GITHUB_JOB: "report",
      GITHUB_WORKFLOW: "test-workflow",
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

await writeArtifacts();
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

try {
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const endpoint = `http://127.0.0.1:${address.port}`;

  const firstStart = requests.length;
  const firstOutput = await runReport(endpoint);
  const firstRequests = requests.slice(firstStart);
  assert.match(
    firstOutput,
    /Teable perf report complete: 6 results \(6 created, 0 updated\)/,
  );
  assert.match(firstOutput, /requests: GET=2, PATCH=0, POST=1/);
  assert.deepEqual(
    firstRequests.map(({ method, recordCount }) => [method, recordCount]),
    [
      ["GET", undefined],
      ["GET", undefined],
      ["POST", 6],
    ],
  );
  assert.equal(firstRequests[1].take, 1_000);
  assert.equal(firstRequests[1].skip, 0);
  assert.equal(storedRecords.length, 6);

  const secondStart = requests.length;
  const secondOutput = await runReport(endpoint);
  const secondRequests = requests.slice(secondStart);
  assert.match(
    secondOutput,
    /Teable perf report complete: 6 results \(0 created, 6 updated\)/,
  );
  assert.match(secondOutput, /requests: GET=2, PATCH=1, POST=0/);
  assert.deepEqual(
    secondRequests.map(({ method, recordCount }) => [method, recordCount]),
    [
      ["GET", undefined],
      ["GET", undefined],
      ["PATCH", 6],
    ],
  );
  assert.equal(storedRecords.length, 6);

  console.log("Teable perf report request batching checks ok");
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(artifactDir, { recursive: true, force: true });
}
