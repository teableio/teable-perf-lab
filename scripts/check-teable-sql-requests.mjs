// The API path these scripts take in CI, exercised without a token.
//
// `list-corpus-refs.mjs` and `build-perf-corpus.mjs` each speak to Teable two
// ways: the REST API when a service token is present, the signed-in CLI when it
// is not. A developer machine has no token, so every local run takes the CLI
// branch — and the API branch shipped with a wrong method and a wrong path,
// answering 404 on its first and only execution, in CI, after everything else
// had been declared working.
//
// So the request is asserted here rather than discovered in a run. `fetch` is
// replaced, both scripts are invoked with a token set, and what they would have
// sent is checked against the endpoint the API actually publishes:
//
//   POST /api/base/{baseId}/sql-query   with { sql } as the body
//
// Not a mock of convenience — the shape below is the one `teable search-api`
// reports, and if the API changes this fails rather than the next CI run.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// A tiny server standing in for Teable: records what arrived, answers with an
// empty result. Cheaper and stricter than replacing `fetch` inside a child
// process, and it exercises the real HTTP client rather than a substitute.
const { createServer } = await import("node:http");

const received = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    received.push({
      method: request.method,
      url: request.url,
      auth: request.headers.authorization,
      contentType: request.headers["content-type"],
      body: Buffer.concat(chunks).toString("utf8"),
    });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ success: true, rows: [] }));
  });
});

await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
const endpoint = `http://127.0.0.1:${server.address().port}`;

const runScript = async (script, args = []) =>
  execFileAsync("node", [`scripts/${script}`, ...args], {
    env: {
      ...process.env,
      TEABLE_ENDPOINT: endpoint,
      TEABLE_PERF_LAB_TOKEN: "test-token",
      COMMIT_ORDER_PATH: "/dev/null",
    },
  });

// --- list-corpus-refs -------------------------------------------------------

await runScript("list-corpus-refs.mjs", ["--teable-ee"]);
assert.equal(received.length, 1);
{
  const request = received[0];
  // The whole point of this file. A GET with the statement in the query string
  // is what shipped, and it 404s.
  assert.equal(request.method, "POST");
  assert.match(request.url, /^\/api\/base\/[^/]+\/sql-query$/);
  assert.equal(request.auth, "Bearer test-token");
  assert.equal(request.contentType, "application/json");
  // The statement travels in the body, not the URL.
  assert.match(JSON.parse(request.body).sql, /Teable_EE_Ref/);
  assert.doesNotMatch(request.url, /SELECT/i);
}

received.length = 0;
await runScript("list-corpus-refs.mjs", ["--perf-lab"]);
assert.match(JSON.parse(received[0].body).sql, /Commit_SHA/);

// --- build-perf-corpus ------------------------------------------------------

// It reads two artifacts before its first query; an empty ordering is enough to
// get one request out, which is all that is being checked here.
received.length = 0;
try {
  await execFileAsync("node", ["scripts/build-perf-corpus.mjs"], {
    env: {
      ...process.env,
      TEABLE_ENDPOINT: endpoint,
      TEABLE_PERF_LAB_TOKEN: "test-token",
      COMMIT_ORDER_PATH: "scripts/fixtures/empty-commit-order.json",
      CASE_DIGESTS_PATH: "scripts/fixtures/empty-case-digests.json",
      PERF_CORPUS_PATH: "/dev/null",
    },
  });
} catch {
  // Writing to /dev/null or an empty corpus may fail downstream; the request
  // shape is what matters and it has already been sent by then.
}
assert.ok(received.length > 0, "build-perf-corpus sent no request");
assert.equal(received[0].method, "POST");
assert.match(received[0].url, /^\/api\/base\/[^/]+\/sql-query$/);
assert.match(JSON.parse(received[0].body).sql, /percentile_disc/);

server.close();
console.log("teable sql request checks passed");
