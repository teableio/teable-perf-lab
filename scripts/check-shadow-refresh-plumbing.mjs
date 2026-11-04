// The shadow analysis actually running its five stages end to end.
//
// `refreshCorpus` spawns five child processes and hands two of them their input
// on stdin. Nothing exercised that. Every check around it tested a model in
// isolation — detection, ordering, digests, reconciliation — and each one
// passed while the orchestration between them could not complete at all:
// asynchronous `execFile` has no `input` option, so both ordering resolvers sat
// waiting for an end-of-input that never arrived. In CI that was 34 minutes of
// silence ended by SIGTERM, which also cost the report job the four steps
// queued behind it.
//
// So this stands up the real thing — two git repositories and an HTTP server
// answering as Teable — and runs `refreshCorpus` against them under a watchdog.
// What it proves is narrow and was exactly what was missing: the stages hand
// off to each other, and the whole thing terminates.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { assertUsable, refreshCorpus } from "./run-shadow-analysis.mjs";
import { performanceTrackFieldsFixture } from "./fixtures/performance-track-fields.mjs";

// --- a corpus that cannot carry an answer is refused ------------------------

// These run first and need no fixture. A zero from the detector means "nothing
// changed"; a zero from a broken clone looks identical in the artifact, in the
// job summary and in the log, and one CI run reported the second as the first.
const healthyOrder = {
  branch: "origin/develop",
  refCount: 571,
  positionedCount: 494,
  mainlineLength: 2704,
};
const seriesOfLength = (count, length) =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `case-${index}`,
      { segments: [Array.from({ length }, (_, point) => [point, 100, 1])] },
    ]),
  );

// The shape a shallow teable-ee clone produces: the mainline is one commit long
// so nothing can be positioned against it.
assert.throws(
  () =>
    assertUsable({
      order: {
        branch: "origin/develop",
        refCount: 573,
        positionedCount: 1,
        mainlineLength: 1,
      },
      corpus: { series: seriesOfLength(40, 150) },
    }),
  /not the history these measurements came from/,
);

// The shape a shallow perf-lab clone produces: ordering is fine, but no commit
// has a digest, so segmentation cuts every series down to single points.
assert.throws(
  () =>
    assertUsable({
      order: healthyOrder,
      corpus: { series: seriesOfLength(40, 1) },
    }),
  /median series carries/,
);

assert.doesNotThrow(() =>
  assertUsable({
    order: healthyOrder,
    corpus: { series: seriesOfLength(40, 150) },
  }),
);

const execFileAsync = promisify(execFile);

const workspace = await mkdtemp(join(tmpdir(), "shadow-plumbing-"));

try {
  // --- two git repositories ---------------------------------------------------

  const git = async (repo, args) =>
    (await execFileAsync("git", ["-C", repo, ...args])).stdout.trim();

  const initRepo = async (name) => {
    const path = join(workspace, name);
    await mkdir(path, { recursive: true });
    await git(path, ["init", "--initial-branch=develop", "--quiet"]);
    await git(path, ["config", "user.email", "check@example.invalid"]);
    await git(path, ["config", "user.name", "check"]);
    return path;
  };

  // Stands in for teable-ee: three commits on the mainline, which is all
  // `resolve-commit-order.mjs` needs to hand back ordinals.
  const teableEeRepo = await initRepo("teable-ee");
  const eeCommits = [];
  for (const message of ["first", "second", "third"]) {
    await writeFile(join(teableEeRepo, "file.txt"), `${message}\n`);
    await git(teableEeRepo, ["add", "."]);
    await git(teableEeRepo, ["commit", "--quiet", "-m", message]);
    eeCommits.push(await git(teableEeRepo, ["rev-parse", "HEAD"]));
  }

  // Stands in for perf-lab: one case file, so `resolve-case-digests.mjs` has
  // something to digest.
  const perfLabRepo = await initRepo("perf-lab");
  await mkdir(join(perfLabRepo, "cases"), { recursive: true });
  await writeFile(
    join(perfLabRepo, "cases", "demo.case.ts"),
    "export default { maxMs: 1000 };\n",
  );
  await git(perfLabRepo, ["add", "."]);
  await git(perfLabRepo, ["commit", "--quiet", "-m", "add case"]);
  const perfCommit = await git(perfLabRepo, ["rev-parse", "HEAD"]);

  // --- an HTTP server answering as Teable -------------------------------------

  // One row per teable-ee commit, so the corpus has a series with a length the
  // segmentation will not throw away.
  const measurements = eeCommits.map((commit, index) => ({
    c: "demo",
    e: "v2",
    r: commit.slice(0, 12),
    p: perfCommit.slice(0, 12),
    m: "duration_ms",
    v: String(100 + index),
    n: "1",
    k: "contract-a",
    h: "runner:Linux:X64:postgres-e2e",
  }));

  const queryKinds = [];
  let metadataReads = 0;
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "GET") {
        metadataReads += 1;
        assert.equal(request.headers.authorization, "Bearer test-token");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(performanceTrackFieldsFixture()));
        return;
      }
      assert.equal(request.method, "POST");
      assert.equal(request.headers.authorization, "Bearer test-token");
      assert.equal(request.headers["content-type"], "application/json");
      const { sql } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(typeof sql, "string");

      let rows;
      if (/percentile_disc/.test(sql)) {
        queryKinds.push("corpus");
        // Paged. The offset is honoured so the loop in `build-perf-corpus.mjs`
        // terminates rather than reading the same page forever.
        const offset = Number(/OFFSET (\d+)/.exec(sql)?.[1] ?? 0);
        const limit = Number(/LIMIT (\d+)/.exec(sql)?.[1] ?? 400);
        rows = measurements.slice(offset, offset + limit);
      } else if (/Teable_EE_Ref/.test(sql)) {
        queryKinds.push("ee-refs");
        rows = eeCommits.map((commit) => ({ r: commit }));
      } else {
        queryKinds.push("perf-refs");
        rows = [{ r: perfCommit }];
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, rows }));
    });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));

  // --- run it -----------------------------------------------------------------

  process.env.TEABLE_ENDPOINT = `http://127.0.0.1:${server.address().port}`;
  process.env.TEABLE_PERF_LAB_TOKEN = "test-token";
  process.env.PERF_LAB_REPO = perfLabRepo;
  process.env.TEABLE_EE_MAINLINE = "develop";

  const workDir = join(workspace, "work");
  await mkdir(workDir, { recursive: true });

  // The watchdog is the point. A stage that waits on stdin does not fail, it
  // waits — and without a deadline this check would hang a CI run the same way
  // the bug it exists for did.
  const corpus = await Promise.race([
    refreshCorpus({ workDir, teableEeRepo }),
    new Promise((_, fail) =>
      setTimeout(
        () =>
          fail(
            new Error(
              "refreshCorpus did not finish within 60s — a stage is stuck, most likely waiting on stdin that was never closed.",
            ),
          ),
        60_000,
      ).unref(),
    ),
  ]);

  server.close();

  // --- what the stages handed each other --------------------------------------

  // Both resolvers read their refs off stdin. If either had been handed
  // nothing it would have thrown "No refs on stdin" instead of producing these.
  const order = JSON.parse(
    await readFile(join(workDir, "commit-order.json"), "utf8"),
  );
  assert.equal(
    order.positionedCount,
    eeCommits.length,
    "commit ordering did not receive the refs listed for it",
  );
  assert.deepEqual(
    eeCommits.map((sha) => order.ordinals[sha]),
    [0, 1, 2],
    "mainline positions are not in commit order",
  );

  const digests = JSON.parse(
    await readFile(join(workDir, "case-digests.json"), "utf8"),
  );
  assert.ok(
    digests.byCommit[perfCommit] !== undefined,
    "case digests did not receive the perf-lab commit listed for it",
  );

  // And the corpus came out the far end with the series intact.
  assert.equal(corpus.seriesCount, 1);
  assert.equal(corpus.measurementIdentityAvailable, true);
  assert.equal(
    corpus.series["demo::v2"].compatibilityMode,
    "strict-insufficient",
  );
  assert.deepEqual(corpus.series["demo::v2"].segmentCompatibility, ["strict"]);
  assert.deepEqual(
    corpus.series["demo::v2"].segments[0].map(([ordinal, value]) => [
      ordinal,
      value,
    ]),
    [
      [0, 100],
      [1, 101],
      [2, 102],
    ],
  );

  // Assert stage handoffs and page termination, not SQL source spelling.
  assert.equal(metadataReads, 1);
  assert.equal(queryKinds.filter((kind) => kind === "ee-refs").length, 1);
  assert.equal(queryKinds.filter((kind) => kind === "perf-refs").length, 1);
  assert.equal(queryKinds.filter((kind) => kind === "corpus").length, 1,
    "one short page must terminate the corpus read");

  // --- a missing clone says so ------------------------------------------------

  await assert.rejects(
    refreshCorpus({ workDir, teableEeRepo: join(workspace, "absent") }),
    /No teable-ee clone at/,
    "a missing teable-ee clone should be reported before any network work",
  );

  console.log("shadow refresh plumbing checks passed");
} finally {
  await rm(workspace, { recursive: true, force: true });
}
