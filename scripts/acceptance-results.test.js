import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { evaluateResults } from "./report-acceptance-results.mjs";
import { sanitizeResults } from "./sanitize-acceptance-results.mjs";

test("keeps outcomes and numbers and drops anything that can carry server data", async () => {
  const source = await mkdtemp(join(tmpdir(), "acceptance-source-"));
  const destination = await mkdtemp(join(tmpdir(), "acceptance-dest-"));
  await writeFile(
    join(source, "case-v2.json"),
    JSON.stringify({
      caseId: "group/case",
      title: "A case",
      runId: "1",
      engine: "v2",
      appUrl: "http://127.0.0.1:3000",
      result: "fail",
      durationMs: 12,
      metrics: { primaryMs: 10, note: "secret" },
      thresholds: [
        { metric: "primaryMs", max: 5, unit: "ms", actual: 10, passed: false },
      ],
      phases: [{ name: "secret" }],
      details: { sql: "secret" },
      measurement: { query: "secret" },
      error: { message: "secret", stack: "secret" },
    }),
  );
  await writeFile(join(source, "other.json"), '{"sql":"secret"}');
  await writeFile(join(source, "summary-case-v2.md"), "secret");

  assert.equal(await sanitizeResults(source, destination), 1);
  assert.deepEqual(await readdir(destination), ["case-v2.json"]);
  const written = await readFile(join(destination, "case-v2.json"), "utf8");
  assert.doesNotMatch(written, /secret|appUrl|runId/);
  const result = JSON.parse(written);
  assert.equal(result.metrics.primaryMs, 10);
  assert.equal(result.error, "withheld in acceptance mode");
});

test("fails on a failed case, a missing case or no results at all", () => {
  const plan = [{ engine: "v2", caseFilter: "a, b" }];
  const pass = (caseId) => ({ caseId, engine: "v2", result: "pass" });

  assert.equal(evaluateResults(plan, [pass("a"), pass("b")]).ok, true);
  assert.deepEqual(evaluateResults(plan, [pass("a")]).missing, ["b (v2)"]);
  assert.deepEqual(
    evaluateResults(plan, [pass("a"), { ...pass("b"), result: "fail" }]).failed,
    ["b (v2)"],
  );
  assert.equal(
    evaluateResults([{ engine: "v2", caseFilter: "all" }], []).ok,
    false,
  );
});
