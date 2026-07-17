import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findCaseFilesOnDisk } from "./case-catalog.mjs";
import { DEFAULT_PERF_CASE_WRITE_MAX_BYTES } from "./perf-case-sync-model.mjs";

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
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  return {
    bytes: body.length,
    value: body.length > 0 ? JSON.parse(body.toString("utf8")) : undefined,
  };
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
      const { bytes, value: body } = await readJson(request);
      entry.bodyBytes = bytes;
      entry.recordCount = body.records.length;
      entry.caseIds = body.records.map((record) => record.fields["Case ID"]);
      for (const update of body.records) {
        const stored = storedRecords.find((record) => record.id === update.id);
        assert.ok(stored, `Unknown record id ${update.id}`);
        stored.fields = { ...stored.fields, ...update.fields };
      }
      respondJson(response, 200, []);
      return;
    }

    if (request.method === "POST" && url.pathname.endsWith("/record")) {
      const { bytes, value: body } = await readJson(request);
      entry.bodyBytes = bytes;
      entry.recordCount = body.records.length;
      entry.caseIds = body.records.map((record) => record.fields["Case ID"]);
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

const runSync = async (endpoint, options = {}) => {
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
      PERF_LAB_CASE_SYNC_MAX_WRITE_BYTES:
        options.maxWriteBytes == null ? "" : String(options.maxWriteBytes),
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
  assert.ok(firstRequests[2].bodyBytes <= DEFAULT_PERF_CASE_WRITE_MAX_BYTES);
  const inlineTagsRecord = storedRecords.find(
    (record) =>
      record.fields["Case ID"] ===
      "lookup/conditional-group-active-flip-1k-fanout100-10k",
  );
  assert.ok(inlineTagsRecord);
  assert.ok(
    Array.isArray(inlineTagsRecord.fields.Tags),
    "inline frontmatter tags must be sent as an array",
  );
  const multilineTagsRecord = storedRecords.find(
    (record) =>
      record.fields["Case ID"] ===
      "lookup/conditional-group-active-text-fanout100-10k",
  );
  assert.ok(multilineTagsRecord);
  assert.ok(
    Array.isArray(multilineTagsRecord.fields.Tags) &&
      multilineTagsRecord.fields.Tags.includes("lookup"),
    "multiline flow frontmatter tags must preserve their values",
  );
  assert.deepEqual(
    storedRecords
      .filter(
        (record) =>
          !Array.isArray(record.fields.Tags) || record.fields.Tags.length === 0,
      )
      .map((record) => record.fields["Case ID"]),
    [],
    "every registered case must retain non-empty tag metadata",
  );

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

  const expectedCaseIds = storedRecords.map(
    (record) => record.fields["Case ID"],
  );
  for (const [index, record] of storedRecords.entries()) {
    record.fields.Title = `stale title ${index}`;
  }
  const maxWriteBytes = 32 * 1024;
  const fourthStart = requests.length;
  const fourthOutput = await runSync(endpoint, { maxWriteBytes });
  const fourthRequests = requests.slice(fourthStart);
  const fourthWrites = fourthRequests.slice(2);
  assert.match(
    fourthOutput,
    new RegExp(
      `Perf case sync summary: created=0, updated=${expectedCaseCount}, unchanged=0`,
    ),
  );
  assert.deepEqual(
    fourthRequests.slice(0, 2).map(({ method }) => method),
    ["GET", "GET"],
  );
  assert.ok(fourthWrites.length > 1, "the byte limit must split large writes");
  assert.ok(
    fourthWrites.every(
      ({ method, bodyBytes }) =>
        method === "PATCH" && bodyBytes <= maxWriteBytes,
    ),
    "every ordered write batch must stay within the configured byte limit",
  );
  assert.deepEqual(
    fourthWrites.flatMap(({ caseIds }) => caseIds),
    expectedCaseIds,
    "byte-bounded batches must preserve registry order",
  );

  storedRecords.length = 0;
  const fifthStart = requests.length;
  const fifthOutput = await runSync(endpoint, { maxWriteBytes });
  const fifthRequests = requests.slice(fifthStart);
  const fifthWrites = fifthRequests.slice(2);
  assert.match(
    fifthOutput,
    new RegExp(
      `Perf case sync summary: created=${expectedCaseCount}, updated=0, unchanged=0`,
    ),
  );
  assert.ok(fifthWrites.length > 1);
  assert.ok(
    fifthWrites.every(
      ({ method, bodyBytes }) =>
        method === "POST" && bodyBytes <= maxWriteBytes,
    ),
  );
  assert.deepEqual(
    fifthWrites.flatMap(({ caseIds }) => caseIds),
    expectedCaseIds,
    "created record batches must preserve registry order",
  );
  assert.match(
    fifthOutput,
    new RegExp(`Perf case created: ${expectedCaseIds[0]} \\(rec-1\\)`),
  );
  assert.match(
    fifthOutput,
    new RegExp(
      `Perf case created: ${expectedCaseIds.at(-1)} \\(rec-${expectedCaseCount}\\)`,
    ),
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
}

console.log("Perf case sync request checks passed.");
