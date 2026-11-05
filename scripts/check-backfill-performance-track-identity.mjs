import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyPerformanceTrackIdentity,
  createIdentityBackfillHttpAdapter,
  runIdentityBackfill,
} from "./backfill-performance-track-identity.mjs";

const identity = (contract = "contract-a", environment = "local") => JSON.stringify({ contract: { id: contract }, environment: { class: environment } });
const row = (n, measurement = identity(), contractId = null, environmentClass = null) => ({
  id: `record-${n}`, n, fields: { "field-source": measurement, "field-contract": contractId, "field-environment": environmentClass, "field-business": `unchanged-${n}` },
});
const fieldMetadata = () => [
  { id: "field-source", name: "Measurement JSON", type: "longText", dbFieldName: "source_renamed" },
  { id: "field-contract", name: "Contract ID", type: "singleLineText", dbFieldName: "contract_generated" },
  { id: "field-environment", name: "Environment Class", type: "singleLineText", dbFieldName: "environment_generated" },
];
const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const respond = (response, status, value) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

// A stateful product-like adapter: scans use an immutable sequence, GETs read
// persisted values, PATCHes mutate storage, and fault injection can commit before
// dropping the response. Assertions concern persisted state, not request echoes.
const withServer = async (initialRows, callback, tableMeta = {}) => {
  const directory = await mkdtemp(join(tmpdir(), "identity-backfill-"));
  // The real GET /base/{base}/table/{table} response has no baseId; do not let a
  // richer test double hide a validation bug the product would trip.
  const metadataResponse = { id: "table-test", name: "Synthetic Track", dbTableName: "physical_table", defaultViewId: "view-test", order: 1, lastModifiedTime: "2026-11-04T00:00:00.000Z", ...tableMeta };
  // Mirror the tool's resolution: an unqualified physical name lives in the
  // project schema, a qualified one is used as written.
  const expectedTableRef = (metadataResponse.dbTableName.includes(".")
    ? metadataResponse.dbTableName
    : `project-test.${metadataResponse.dbTableName}`
  ).split(".").map((part) => `"${part}"`).join(".");
  const state = { rows: structuredClone(initialRows), fields: fieldMetadata(), requests: [], patches: [], getCount: new Map(), onRead: null, beforePatch: null, afterPatch: null, onScan: null, serverError: null };
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Bearer synthetic-token");
      const url = new URL(request.url, "http://127.0.0.1");
      state.requests.push({ method: request.method, path: url.pathname });
      if (request.method === "GET" && url.pathname === "/api/base/project-test/table/table-test") {
        respond(response, 200, metadataResponse); return;
      }
      if (request.method === "GET" && url.pathname === "/api/table/table-test/field") {
        respond(response, 200, state.fields); return;
      }
      if (request.method === "POST" && url.pathname === "/api/base/project-test/sql-query") {
        const { sql } = await readBody(request);
        assert.match(sql, /^SELECT /);
        assert.ok(sql.includes(`FROM ${expectedTableRef}`));
        assert.ok(!/OFFSET|UPDATE|INSERT|DELETE|Measurement|source_renamed/i.test(sql));
        if (sql.includes('MAX("__auto_number")')) {
          respond(response, 200, { rows: [{ h: Math.max(0, ...state.rows.map((stored) => stored.n)) }] }); return;
        }
        const match = sql.match(/WHERE "__auto_number" > (\d+) AND "__auto_number" <= (\d+) ORDER BY "__auto_number" ASC LIMIT (\d+)$/);
        assert.ok(match, "scan must use bounded stable keyset, not a shrinking scalar filter");
        const [, cursor, highWater, limit] = match.map(Number);
        const rows = state.rows.filter((stored) => stored.n > cursor && stored.n <= highWater).sort((a, b) => a.n - b.n).slice(0, limit).map(({ id, n }) => ({ id, n }));
        if (state.onScan) await state.onScan(state);
        respond(response, 200, { rows }); return;
      }
      const match = url.pathname.match(/^\/api\/table\/table-test\/record\/(record-\d+)$/);
      if (match && request.method === "GET") {
        assert.equal(url.searchParams.get("fieldKeyType"), "id");
        assert.deepEqual(url.searchParams.getAll("projection"), ["field-source", "field-contract", "field-environment"]);
        const stored = state.rows.find((candidate) => candidate.id === match[1]);
        if (!stored) { respond(response, 404, {}); return; }
        const count = (state.getCount.get(stored.id) ?? 0) + 1;
        state.getCount.set(stored.id, count);
        if (state.onRead) await state.onRead(stored, count, state);
        respond(response, 200, { id: stored.id, fields: Object.fromEntries(url.searchParams.getAll("projection").map((id) => [id, stored.fields[id]])) }); return;
      }
      if (match && request.method === "PATCH") {
        const stored = state.rows.find((candidate) => candidate.id === match[1]);
        assert.ok(stored);
        const body = await readBody(request);
        assert.equal(body.fieldKeyType, "id");
        assert.equal(body.typecast, false);
        assert.deepEqual(Object.keys(body).sort(), ["fieldKeyType", "record", "typecast"]);
        const patchKeys = Object.keys(body.record.fields);
        assert.ok(patchKeys.length >= 1 && patchKeys.length <= 2);
        assert.ok(patchKeys.every((key) => ["field-contract", "field-environment"].includes(key)));
        assert.ok(Object.values(body.record.fields).every((value) => typeof value === "string" && value.trim().length > 0), "PATCH never invents or clears a missing source component");
        const attempt = { id: stored.id, fields: structuredClone(body.record.fields) };
        state.patches.push(attempt);
        if (state.beforePatch && await state.beforePatch(stored, state, response)) return;
        stored.fields = { ...stored.fields, ...body.record.fields };
        if (state.afterPatch && await state.afterPatch(stored, state, response)) return;
        respond(response, 200, { id: stored.id, fields: structuredClone(stored.fields) }); return;
      }
      respond(response, 404, {});
    } catch (error) {
      state.serverError = error;
      respond(response, 500, {});
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const checkpointPath = join(directory, "checkpoint.json");
  const adapter = createIdentityBackfillHttpAdapter({ endpoint, token: "synthetic-token", baseId: "project-test", tableId: "table-test" });
  const config = { endpoint, baseId: "project-test", tableId: "table-test", checkpointPath, adapter };
  const apply = { mode: "apply", acknowledgeWritersPausedAndDrained: true, fenceProvenance: "synthetic maintenance fence, all writers drained" };
  try {
    await callback({ state, config, apply, directory });
    if (state.serverError) throw state.serverError;
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await rm(directory, { recursive: true, force: true });
  }
};
const checkpoint = async (config) => JSON.parse(await readFile(config.checkpointPath, "utf8"));
const assertUntouchedBusiness = (state) => {
  for (const stored of state.rows) assert.equal(stored.fields["field-business"], `unchanged-${stored.n}`);
};

const checkPartialIdentitySemantics = async () => {
  // Deliberately independent historical source literals: contract-only A/B and
  // environment-only local/ci partition legacy corpus aggregates separately.
  const partialRows = [
    [1, '{"contract":{"id":"partial-a"}}', 1],
    [2, '{"contract":{"id":"partial-b"}}', 100],
    [3, '{"contract":{"id":"partial-b"}}', 100],
    [4, '{"contract":{"id":"partial-b"}}', 100],
    [5, '{"environment":{"class":"partial-local"}}', 2],
    [6, '{"environment":{"class":"partial-ci"}}', 200],
    [7, '{"environment":{"class":"partial-ci"}}', 200],
    [8, '{"environment":{"class":"partial-ci"}}', 200],
  ].map(([n, source, value]) => {
    const stored = row(n, source);
    stored.fields["field-metric"] = value;
    return stored;
  });
  const median = (values) => {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  };
  const corpusGrouping = (rows, source) => {
    const groups = new Map();
    for (const stored of rows) {
      const decoded = source ? JSON.parse(stored.fields["field-source"]) : null;
      const key = JSON.stringify(source
        ? [decoded.contract?.id ?? null, decoded.environment?.class ?? null]
        : [stored.fields["field-contract"] ?? null, stored.fields["field-environment"] ?? null]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(stored.fields["field-metric"]);
    }
    return [...groups].map(([key, values]) => [key, median(values)]).sort(([a], [b]) => a.localeCompare(b));
  };
  await withServer(partialRows, async ({ state, config, apply, directory }) => {
    const oldContractGroups = corpusGrouping(state.rows.slice(0, 4), true);
    assert.deepEqual(oldContractGroups, [['["partial-a",null]', 1], ['["partial-b",null]', 100]]);
    assert.equal(median(oldContractGroups.map(([, value]) => value)), 50.5);
    assert.equal(median(corpusGrouping(state.rows.slice(0, 4), false).map(([, value]) => value)), 100, "fixture exposes the collapsed-scalar median regression before migration");
    const expectedGroups = corpusGrouping(state.rows, true);
    const initial = structuredClone(state.rows);
    const result = await runIdentityBackfill({ ...config, ...apply });
    const actualContractGroups = corpusGrouping(state.rows.slice(0, 4), false);
    assert.equal(median(actualContractGroups.map(([, value]) => value)), 50.5, "migration must preserve legacy contract-only A/B corpus series median (not collapse to 100)");
    assert.deepEqual(corpusGrouping(state.rows, false), expectedGroups, "contract-only and environment-only corpus group keys/medians must survive migration");
    assert.equal(result.counts["missing-or-incomplete-identity"], 8, "partial identity audit category remains explicit after copying available components");
    assert.equal(result.updated, 8);
    assert.equal(state.patches.length, 8);
    for (let index = 0; index < state.rows.length; index++) {
      const stored = state.rows[index];
      assert.equal(stored.fields["field-source"], initial[index].fields["field-source"]);
      assert.equal(stored.fields["field-metric"], initial[index].fields["field-metric"]);
      assert.ok(!stored.fields["field-contract"] || !stored.fields["field-environment"], "partial source must remain strict-ineligible: no fabricated pair component");
      assert.equal(Object.keys(state.patches[index].fields).length, 1, "PATCH only the available missing component");
      assert.ok(Object.values(state.patches[index].fields).every((value) => typeof value === "string" && value.length > 0));
    }
    assertUntouchedBusiness(state);
    const repeated = await runIdentityBackfill({ ...config, ...apply, checkpointPath: join(directory, "partial-reconcile.json") });
    assert.equal(repeated.counts["missing-or-incomplete-identity"], 8);
    assert.equal(repeated.updated, 0);
    assert.equal(state.patches.length, 8, "repeated reconciliation must not rewrite already copied partial components");
  });
  console.log("Partial identity migration: legacy A/B series median 50.5, environment-only grouping retained, 8 incomplete rows updated once, strict-ineligible and idempotent");
};

await checkPartialIdentitySemantics();
if (!process.argv.includes("--partial-identity-only")) {

assert.equal(classifyPerformanceTrackIdentity({ measurement: "{" }).category, "invalid-json");
for (const measurement of [undefined, null, "", "null", "42", '"value"', '[]', '{"contract":{"id":"only"}}', '{"contract":{"id":{}},"environment":{"class":"local"}}']) {
  assert.equal(classifyPerformanceTrackIdentity({ measurement }).category, "missing-or-incomplete-identity");
}
assert.deepEqual(classifyPerformanceTrackIdentity({ measurement: identity(" Contract ", "LOCAL ") }), {
  category: "valid-missing", identity: { contractId: " Contract ", environmentClass: "LOCAL " },
});
assert.equal(classifyPerformanceTrackIdentity({ measurement: identity(), contractId: "contract-a" }).category, "partial-compatible");
assert.equal(classifyPerformanceTrackIdentity({ measurement: identity(), environmentClass: "LOCAL" }).category, "conflict");
assert.equal(classifyPerformanceTrackIdentity({ measurement: identity(), contractId: { value: "contract-a" } }).category, "conflict");

// Independent eligibility fixtures: the strict reader's target pair is fixed,
// and expected outcomes are stated rather than derived from the writer/helper.
// Source-less scalar pairs must not survive migration as apparently strict rows.
const historicalEligibilityFixtures = [
  { measurement: "{", contractId: "contract-a", environmentClass: "local", category: "conflict", legacyEligible: false, scalarEligible: true },
  { measurement: "{", contractId: "contract-a", environmentClass: null, category: "conflict", legacyEligible: false, scalarEligible: false },
  { measurement: "{", contractId: null, environmentClass: null, category: "invalid-json", legacyEligible: false, scalarEligible: false },
  { measurement: undefined, contractId: "contract-a", environmentClass: "local", category: "conflict", legacyEligible: false, scalarEligible: true },
  { measurement: null, contractId: "contract-a", environmentClass: null, category: "conflict", legacyEligible: false, scalarEligible: false },
  { measurement: "null", contractId: null, environmentClass: "local", category: "conflict", legacyEligible: false, scalarEligible: false },
  { measurement: '{"contract":{"id":"contract-a"}}', contractId: "contract-a", environmentClass: "local", category: "conflict", legacyEligible: false, scalarEligible: true },
  { measurement: '{"environment":{"class":"local"}}', contractId: "contract-a", environmentClass: "local", category: "conflict", legacyEligible: false, scalarEligible: true },
  { measurement: '{"contract":{"id":"contract-a"}}', contractId: "contract-a", environmentClass: null, category: "missing-or-incomplete-identity", legacyEligible: false, scalarEligible: false },
  { measurement: '{"environment":{"class":"local"}}', contractId: null, environmentClass: "local", category: "missing-or-incomplete-identity", legacyEligible: false, scalarEligible: false },
  { measurement: '{"contract":{"id":{}},"environment":{"class":"local"}}', contractId: "contract-a", environmentClass: "local", category: "conflict", legacyEligible: false, scalarEligible: true },
  { measurement: identity(), contractId: "contract-a", environmentClass: "local", category: "already-matching", legacyEligible: true, scalarEligible: true },
];
for (const fixture of historicalEligibilityFixtures) {
  let source;
  try { source = typeof fixture.measurement === "string" ? JSON.parse(fixture.measurement) : fixture.measurement; } catch { source = undefined; }
  const legacyEligible = source?.contract?.id === "contract-a" && source?.environment?.class === "local";
  const scalarEligible = fixture.contractId === "contract-a" && fixture.environmentClass === "local";
  assert.equal(legacyEligible, fixture.legacyEligible);
  assert.equal(scalarEligible, fixture.scalarEligible);
  assert.equal(classifyPerformanceTrackIdentity(fixture).category, fixture.category);
  if (scalarEligible && !legacyEligible) assert.equal(fixture.category, "conflict");
  if (fixture.category === "conflict") {
    const stale = row(1, fixture.measurement, fixture.contractId, fixture.environmentClass);
    stale.fields["field-source"] = fixture.measurement;
    await withServer([stale, row(2)], async ({ state, config, apply }) => {
      const before = structuredClone(state.rows);
      await assert.rejects(runIdentityBackfill({ ...config, ...apply }), (error) => error.category === "conflict");
      assert.equal((await checkpoint(config)).cursor, 0);
      assert.equal(state.patches.length, 0, "stale targets cannot be silently preserved as migrated or overwritten");
      assert.deepEqual(state.rows, before);
    });
  }
}

await withServer([row(1, '{"contract":{"id":"contract-a"}}', "contract-a")], async ({ state, config, apply }) => {
  const result = await runIdentityBackfill({ ...config, ...apply });
  assert.equal(result.counts["missing-or-incomplete-identity"], 1);
  assert.equal(result.complete, true);
  assert.equal(state.rows[0].fields["field-environment"], null);
  assert.equal(state.patches.length, 0, "a matching incomplete pair stays incomplete and strict-ineligible");
});

await withServer([
  row(1), row(2, identity(), "contract-a"), row(3, identity(), "contract-a", "local"), row(4, "{"), row(5, '{"contract":{"id":"only"}}'),
], async ({ state, config }) => {
  const before = structuredClone(state.rows);
  const result = await runIdentityBackfill(config);
  assert.equal(result.complete, true);
  assert.deepEqual(result.counts, { "already-matching": 1, "valid-missing": 1, "partial-compatible": 1, conflict: 0, "invalid-json": 1, "missing-or-incomplete-identity": 1 });
  assert.deepEqual(state.rows, before, "default plan must never change stored rows");
  assert.equal(state.patches.length, 0);
  const saved = JSON.stringify(await checkpoint(config));
  assert.ok(!saved.includes("synthetic-token"));
  assert.ok(!saved.includes('"contract":{"id"'));
  assert.ok(saved.includes("source_renamed"), "checkpoint binds actual source database metadata");
});

await withServer([row(1), row(4), row(9)], async ({ state, config, apply, directory }) => {
  const sources = state.rows.map((stored) => stored.fields["field-source"]);
  const first = await runIdentityBackfill({ ...config, ...apply, pageSize: 1, maxRows: 2 });
  assert.equal(first.cursor, 4);
  assert.equal(first.complete, false);
  assert.equal(first.updated, 2);
  const second = await runIdentityBackfill({ ...config, ...apply, resume: true, pageSize: 1 });
  assert.equal(second.cursor, 9);
  assert.equal(second.updated, 3);
  assert.equal(second.complete, true);
  assert.deepEqual(state.rows.map((stored) => stored.fields["field-source"]), sources);
  assertUntouchedBusiness(state);
  const repeat = await runIdentityBackfill({ ...config, ...apply, checkpointPath: join(directory, "idempotent.json") });
  assert.equal(repeat.counts["already-matching"], 3);
  assert.equal(repeat.updated, 0);
  assert.equal(state.patches.length, 3, "idempotent rerun must not PATCH already matching data");
});

await withServer([row(1), row(2), row(3)], async ({ state, config, apply }) => {
  state.beforePatch = (stored, current, response) => {
    if (stored.n === 2) { respond(response, 503, {}); return true; }
    return false;
  };
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, pageSize: 3 }), /PATCH.*503/);
  assert.equal((await checkpoint(config)).cursor, 0, "partial acknowledgement cannot advance page cursor");
  assert.equal(state.rows[0].fields["field-contract"], "contract-a");
  assert.equal(state.rows[1].fields["field-contract"], null);
  assert.equal(state.rows[2].fields["field-contract"], null);
  state.beforePatch = null;
  const resumed = await runIdentityBackfill({ ...config, ...apply, resume: true, pageSize: 3 });
  assert.equal(resumed.complete, true);
  assert.equal(resumed.counts["already-matching"], 1);
  assert.equal(resumed.updated, 2, "updated counts only writes acknowledged in committed pages, not guesses about lost responses");
  assert.equal(state.patches.filter(({ id }) => id === "record-1").length, 1, "replay reclassifies earlier acknowledged rows");
  assertUntouchedBusiness(state);
});

await withServer([row(1), row(2)], async ({ state, config, apply }) => {
  state.afterPatch = (stored, current, response) => {
    if (stored.n === 1) { response.destroy(); return true; }
    return false;
  };
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, pageSize: 2 }));
  assert.equal((await checkpoint(config)).cursor, 0);
  assert.equal(state.rows[0].fields["field-contract"], "contract-a", "server committed before response was lost");
  assert.equal(state.rows[1].fields["field-contract"], null);
  assert.equal(state.patches.length, 1, "unknown outcome must not trigger implicit write retry");
  state.afterPatch = null;
  const result = await runIdentityBackfill({ ...config, ...apply, resume: true, pageSize: 2 });
  assert.equal(result.complete, true);
  assert.equal(result.counts["already-matching"], 1);
  assert.equal(state.patches.length, 2, "resume reclassifies committed unknown-outcome record without rewriting it");
});

await withServer([row(1), row(2)], async ({ state, config, apply }) => {
  state.onRead = (stored, count) => { if (stored.n === 1 && count === 2) stored.fields["field-source"] = identity("changed"); };
  await assert.rejects(runIdentityBackfill({ ...config, ...apply }), /source\/targets changed/);
  assert.equal(state.patches.length, 0);
  assert.equal((await checkpoint(config)).cursor, 0);
  assert.equal(state.rows[0].fields["field-contract"], null);
});

await withServer([row(1), row(2)], async ({ state, config, apply }) => {
  state.onRead = (stored, count) => { if (stored.n === 1 && count === 2) stored.fields["field-contract"] = "conflicting-writer"; };
  await assert.rejects(runIdentityBackfill({ ...config, ...apply }), /source\/targets changed/);
  assert.equal(state.patches.length, 0);
  assert.equal(state.rows[0].fields["field-contract"], "conflicting-writer");
});

await withServer([row(1, identity(), "other-contract"), row(2)], async ({ state, config, apply }) => {
  const before = structuredClone(state.rows);
  await assert.rejects(runIdentityBackfill({ ...config, ...apply }), (error) => error.category === "conflict" && error.counts.conflict === 1);
  assert.deepEqual(state.rows, before);
  assert.equal(state.patches.length, 0);
  assert.equal((await checkpoint(config)).cursor, 0);
});

await withServer([row(1)], async ({ state, config, apply }) => {
  await assert.rejects(runIdentityBackfill({ ...config, mode: "apply" }), /ALL writers/);
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, fenceProvenance: "" }), /ALL writers/);
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, acknowledgeWritersPausedAndDrained: false }), /ALL writers/);
  assert.equal(state.requests.length, 0, "missing fence acknowledgement fails before any request");
});

await withServer([row(1), row(2)], async ({ state, config, apply }) => {
  await runIdentityBackfill({ ...config, ...apply, maxRows: 1, pageSize: 1 });
  const patches = state.patches.length;
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, tableId: "wrong-target", resume: true }), /mismatch/);
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, baseId: "wrong-project", resume: true }), /mismatch/);
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, endpoint: "http://localhost:9999", resume: true }), /mismatch/);
  await assert.rejects(runIdentityBackfill({ ...config, mode: "plan", resume: true }), /mismatch/);
  state.fields[1].id = "changed-field-id";
  await assert.rejects(runIdentityBackfill({ ...config, ...apply, resume: true }), /mismatch/);
  assert.equal(state.patches.length, patches);
});

await withServer([row(1)], async ({ state, config, apply }) => {
  state.onScan = (current) => { current.rows.push(row(2)); current.onScan = null; };
  await assert.rejects(runIdentityBackfill({ ...config, ...apply }), /high-water mark changed/);
  assert.equal(state.patches.length, 0);
  assert.equal((await checkpoint(config)).cursor, 0);
});

await withServer([row(1)], async ({ state, config, apply }) => {
  state.onScan = (current) => { current.fields[0].dbFieldName = "changed_source"; current.onScan = null; };
  await assert.rejects(runIdentityBackfill({ ...config, ...apply }), /Schema changed/);
  assert.equal(state.patches.length, 0);
});

await withServer([row(1, "x".repeat(2048))], async ({ state, config }) => {
  await assert.rejects(runIdentityBackfill({ ...config, maxBytes: 256 }), /byte bound exceeded/);
  assert.equal((await checkpoint(config)).cursor, 0);
  assert.equal(state.patches.length, 0);
});

await withServer([row(1)], async ({ state, config, directory }) => {
  const script = fileURLToPath(new URL("./backfill-performance-track-identity.mjs", import.meta.url));
  const child = spawn(process.execPath, [script, "--checkpoint", join(directory, "cli.json")], {
    env: { ...process.env, TEABLE_ENDPOINT: config.endpoint, TEABLE_PERF_LAB_BASE_ID: config.baseId, TEABLE_PERF_LAB_TRACK_TABLE_ID: config.tableId, TEABLE_PERF_LAB_TOKEN: "synthetic-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(exit, 0, stderr);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "plan");
  assert.equal(result.counts["valid-missing"], 1);
  assert.equal(state.patches.length, 0);
  assert.ok(!stdout.includes("contract-a"));
  assert.ok(!stdout.includes("synthetic-token"));
  assert.ok(!stdout.includes("record-1"));
  const applyChild = spawn(process.execPath, [script, "--checkpoint", join(directory, "cli-apply.json"), "--apply", "--writers-paused-and-drained", "--fence-provenance", "synthetic external fence"], {
    env: { ...process.env, TEABLE_ENDPOINT: config.endpoint, TEABLE_PERF_LAB_BASE_ID: config.baseId, TEABLE_PERF_LAB_TRACK_TABLE_ID: config.tableId, TEABLE_PERF_LAB_TOKEN: "synthetic-token" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let applyStdout = "";
  let applyStderr = "";
  applyChild.stdout.on("data", (chunk) => { applyStdout += chunk; });
  applyChild.stderr.on("data", (chunk) => { applyStderr += chunk; });
  const applyExit = await new Promise((resolve, reject) => { applyChild.on("error", reject); applyChild.on("close", resolve); });
  assert.equal(applyExit, 0, applyStderr);
  assert.equal(JSON.parse(applyStdout).updated, 1);
  assert.equal(state.patches.length, 1);
  assert.equal(state.rows[0].fields["field-contract"], "contract-a");
  assert.equal(state.rows[0].fields["field-environment"], "local");
  assert.equal(state.rows[0].fields["field-source"], identity());
  assertUntouchedBusiness(state);
});

await withServer([row(1)], async ({ state, config }) => {
  state.onScan = (current) => { current.rows.push(row(2)); current.onScan = null; };
  const result = await runIdentityBackfill({ ...config, pageSize: 1 });
  assert.equal(result.highWater, 1);
  assert.equal(result.cursor, 1);
  assert.equal(result.counts["valid-missing"], 1, "later inserts must not expand the captured scan universe");
  assert.equal(state.patches.length, 0);
});

await withServer([row(1, "{"), row(2, "null"), row(3, identity(), "contract-a")], async ({ state, config, apply }) => {
  const result = await runIdentityBackfill({ ...config, ...apply });
  assert.equal(result.cursor, 3);
  assert.equal(result.counts["invalid-json"], 1);
  assert.equal(result.counts["missing-or-incomplete-identity"], 1);
  assert.equal(result.counts["partial-compatible"], 1);
  assert.equal(result.updated, 1);
  assert.equal(state.patches.length, 1);
  assert.equal(state.rows[0].fields["field-contract"], null);
  assert.equal(state.rows[1].fields["field-contract"], null);
  assert.equal(state.rows[2].fields["field-contract"], "contract-a");
  assert.equal(state.rows[2].fields["field-environment"], "local");
});

// Metadata shapes the product actually returns: no baseId, unqualified
// dbTableName, or an explicitly project-qualified one.
for (const tableMeta of [{}, { dbTableName: "project-test.physical_table" }]) {
  await withServer([row(1)], async ({ state, config, apply }) => {
    const result = await runIdentityBackfill({ ...config, ...apply });
    assert.equal(result.counts["valid-missing"], 1);
    assert.equal(state.rows[0].fields["field-contract"], "contract-a");
  }, tableMeta);
}

await withServer([row(1)], async ({ state, config }) => {
  await assert.rejects(runIdentityBackfill({ ...config }), /does not match target/);
  assert.equal(state.requests.length, 2, "rejection happens on metadata, before any SQL or PATCH");
  assert.equal(state.patches.length, 0);
}, { id: "other-table" });

await withServer([row(1)], async ({ state, config }) => {
  await assert.rejects(runIdentityBackfill({ ...config }), /does not match target/);
  assert.equal(state.patches.length, 0);
}, { baseId: "other-project" });

await withServer([row(1)], async ({ state, config }) => {
  await assert.rejects(runIdentityBackfill({ ...config }), /does not belong to the target project/);
  assert.equal(state.patches.length, 0);
}, { dbTableName: "other-project.physical_table" });

console.log("Performance Track identity backfill: classification, bounded plan/apply HTTP, immutable cursor, fence refusal, conflict preservation, partial/unknown acknowledgement resume, idempotence, target binding, source-change detection passed");
}
