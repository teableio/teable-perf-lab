// Real HTTP clients against a stateful local Teable stand-in. These checks
// assert transport, output, and schema failures, not incidental SQL spelling.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { loadSameRunHistory } from "./resolve-same-run-history.mjs";
import { performanceTrackFieldsFixture } from "./fixtures/performance-track-fields.mjs";

const execFileAsync = promisify(execFile);
const workspace = await mkdtemp(join(tmpdir(), "teable-sql-requests-"));
const received = [];
let fields = performanceTrackFieldsFixture();
let sqlResponses = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    received.push({ method: request.method, url: request.url, auth: request.headers.authorization,
      contentType: request.headers["content-type"], body: Buffer.concat(chunks).toString("utf8") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(request.method === "GET" ? fields : (sqlResponses.shift() ?? { success: true, rows: [] })));
  });
});
await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const endpoint = `http://127.0.0.1:${server.address().port}`;
const environment = {
  ...process.env, TEABLE_ENDPOINT: endpoint, TEABLE_PERF_LAB_TOKEN: "test-token",
  COMMIT_ORDER_PATH: join(workspace, "order.json"), CASE_DIGESTS_PATH: join(workspace, "digests.json"),
  PERF_CORPUS_PATH: join(workspace, "corpus.json"),
};
const runScript = (script, args = []) => execFileAsync("node", [`scripts/${script}`, ...args], { env: environment });
const assertSqlTransport = (requests) => {
  assert.ok(requests.length > 0, "expected SQL requests");
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.match(request.url, /^\/api\/base\/[^/]+\/sql-query$/);
    assert.equal(request.auth, "Bearer test-token");
    assert.equal(request.contentType, "application/json");
    const body = JSON.parse(request.body);
    assert.deepEqual(Object.keys(body), ["sql"]);
    assert.equal(typeof body.sql, "string");
    assert.ok(body.sql.trim().length > 0);
    assert.doesNotMatch(request.url, /SELECT/i);
  }
};
const assertMetadataTransport = () => {
  const requests = received.filter((request) => request.method === "GET");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /^\/api\/table\/[^/]+\/field$/);
  assert.equal(requests[0].auth, "Bearer test-token");
};
// Keep abbreviated synthetic commit IDs unique just like real commit prefixes.
const eeCommits = Array.from({ length: 30 }, (_, index) => (index + 1).toString(16).padStart(12, "0") + "0".repeat(28));
const perfCommit = "a".repeat(40);
const corpusRows = eeCommits.map((commit, index) => ({
  c: "demo", e: "v2", r: commit.slice(0, 12), p: perfCommit.slice(0, 12),
  m: "duration_ms", v: String(100 + index), n: "1", k: "contract-neutral", h: "local-disposable",
}));
const previousEnvironment = { TEABLE_ENDPOINT: process.env.TEABLE_ENDPOINT, TEABLE_PERF_LAB_TOKEN: process.env.TEABLE_PERF_LAB_TOKEN };
try {
  await writeFile(environment.COMMIT_ORDER_PATH, JSON.stringify({ ordinals: Object.fromEntries(eeCommits.map((commit, index) => [commit, index])), excluded: {} }));
  await writeFile(environment.CASE_DIGESTS_PATH, JSON.stringify({ byCommit: { [perfCommit]: "synthetic" }, snapshots: { synthetic: { demo: "workload-neutral" } } }));
  for (const argument of ["--teable-ee", "--perf-lab"]) {
    received.length = 0;
    await runScript("list-corpus-refs.mjs", [argument]);
    assert.equal(received.length, 1);
    assertSqlTransport(received);
  }

  // Both scalar keys survive HTTP -> corpus segmentation. Thirty strict
  // points qualify, twenty-nine do not; metrics values/metric names survive.
  for (const count of [30, 29]) {
    received.length = 0;
    sqlResponses = [{ success: true, rows: corpusRows.slice(0, count) }];
    await runScript("build-perf-corpus.mjs");
    assertMetadataTransport();
    assertSqlTransport(received.filter((request) => request.method !== "GET"));
    assert.equal(received.filter((request) => request.method === "POST").length, 1);
    const corpus = JSON.parse(await readFile(environment.PERF_CORPUS_PATH, "utf8"));
    assert.equal(corpus.measurementIdentityAvailable, true);
    assert.equal(corpus.seriesCount, 1);
    assert.equal(corpus.series["demo::v2"].metric, "duration_ms");
    assert.equal(corpus.series["demo::v2"].compatibilityMode, count === 30 ? "strict" : "strict-insufficient");
    assert.deepEqual(corpus.series["demo::v2"].segmentCompatibility, ["strict"]);
    assert.deepEqual(corpus.series["demo::v2"].segments[0], Array.from({ length: count }, (_, index) => [index, 100 + index, 1]));
  }

  process.env.TEABLE_ENDPOINT = endpoint;
  process.env.TEABLE_PERF_LAB_TOKEN = "test-token";
  const historyOptions = { caseIds: ["demo"], currentRunId: "run-current", identityByCase: { demo: { contractId: "contract-neutral", environmentClass: "local-disposable" } } };
  received.length = 0;
  const historyRows = Array.from({ length: 60 }, (_, index) => ({ c: "demo", v: index + 1, t: new Date(Date.UTC(2026, 0, index + 1)).toISOString(), k: "contract-neutral", h: "local-disposable" }));
  sqlResponses = [{ success: true, rows: historyRows }, { success: true, rows: historyRows }];
  const history = await loadSameRunHistory(historyOptions);
  assertMetadataTransport();
  assertSqlTransport(received.filter((request) => request.method !== "GET"));
  assert.equal(received.filter((request) => request.method === "POST").length, 2);
  assert.equal(history.compatibilityByCase.demo.mode, "strict");
  assert.deepEqual(history.valuesByCase.demo, Array.from({ length: 60 }, (_, index) => index + 1));

  // A partial/wrong-type rollout must fail before issuing SQL, never silently
  // downgrade to the legacy JSON path. No exact English error wording pinned.
  for (const invalidFields of [
    performanceTrackFieldsFixture().filter((field) => field.name !== "Environment Class"),
    performanceTrackFieldsFixture().map((field) => field.name === "Contract ID" ? { ...field, type: "longText" } : field),
  ]) {
    fields = invalidFields;
    received.length = 0;
    await assert.rejects(loadSameRunHistory(historyOptions));
    assertMetadataTransport();
    assert.equal(received.filter((request) => request.method === "POST").length, 0);
    received.length = 0;
    await assert.rejects(runScript("build-perf-corpus.mjs"));
    assertMetadataTransport();
    assert.equal(received.filter((request) => request.method === "POST").length, 0);
  }

  fields = performanceTrackFieldsFixture();
  received.length = 0;
  sqlResponses = [{ success: false, error: "synthetic rejected query" }];
  await assert.rejects(runScript("build-perf-corpus.mjs"));
  assertMetadataTransport();
  assert.equal(received.filter((request) => request.method === "POST").length, 1);
  assertSqlTransport(received.filter((request) => request.method !== "GET"));
  console.log("teable sql transport, scalar corpus/history, and schema failure checks passed");
} finally {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(workspace, { recursive: true, force: true });
}
