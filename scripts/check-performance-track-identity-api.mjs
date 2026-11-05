#!/usr/bin/env node
/**
 * Disposable, REAL local-product API acceptance replay (Node 20+).
 *
 * T8351_API_ENDPOINT=http://127.0.0.1:3123 \
 * T8351_API_BASE_ID=bseTestBaseId T8351_API_TOKEN=<local-PAT> \
 *   node scripts/check-performance-track-identity-api.mjs
 *
 * Supply the token through your shell/secret injector, not a committed command.
 * Required local PAT permissions: table create/read/permanent-delete, field
 * read, record create/read/update, and project SQL SELECT. The API must use
 * PostgreSQL with UTC database sessions, matching the baseline deployment.
 * No CLI, MCP, direct database access, or production fallback is used.
 *
 * This script ALWAYS creates a fresh randomly named table. It cannot accept an
 * existing table ID. Finally it permanently deletes only that returned table and
 * removes its own temporary checkpoints. Do not kill the process during cleanup.
 * It creates no managed indexes: this is functional API proof, not a plan or
 * performance benchmark (the separate PostgreSQL replay owns that evidence).
 *
 * Stages: metadata -> real writer create/update/repeat/clear and batch upsert ->
 * history + historical JSON fixtures -> read-only migration plan -> bounded
 * apply/resume -> idempotent reconciliation -> JSON/scalar corpus grouping and
 * ordered series equivalence -> scalar history SQL, partial strict exclusion,
 * and 51/52 selection -> permanent cleanup. PASS is printed only after cleanup.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PERFORMANCE_TRACK_CONTRACT_FIELDS } from "./performance-track-contract.fixture.mjs";
import {
  buildPerformanceTrackResultRecord,
  createTeablePerformanceTrackAdapter,
  createPerformanceTrackRecordModule,
} from "./performance-track-record-model.mjs";
import {
  createIdentityBackfillHttpAdapter,
  runIdentityBackfill,
} from "./backfill-performance-track-identity.mjs";
import { resolvePerformanceTrackIdentityColumns } from "./performance-track-identity.mjs";
import { buildSameRunHistorySql, rowsFromSqlResult } from "./resolve-same-run-history.mjs";
import { comparableHistoryByCaseFromRows } from "./same-run-comparison-model.mjs";
import { buildPerfCorpusPageSql } from "./build-perf-corpus.mjs";
import { buildOrderedSeries } from "./commit-order-model.mjs";

const HELP = `Usage: node scripts/check-performance-track-identity-api.mjs [--help]
Required environment (no defaults):
  T8351_API_ENDPOINT  HTTP(S) origin on 127.0.0.1, localhost, or [::1]
  T8351_API_BASE_ID   Existing disposable local project, e.g. bseTestBaseId
  T8351_API_TOKEN     Local PAT with table/field/record and SQL read permissions
                      that allows at least 100 records per read (this replay
                      paginates its own reads at 100)
Database sessions must use UTC; fixture timestamps are exact UTC instants.
Creates its OWN fresh fixture table; permanently deletes it in finally.
Never accepts an existing target table. Rejects credentials/path/query/fragment
in the origin, non-loopback URLs, and redirects. Never logs the token or payloads.
No production calls, CLI, MCP, direct SQL writes, mocks, or benchmark claims.
Stages: writer; migration plan/apply/resume/idempotence; historical JSON versus
scalar corpus groups/series; scalar history/strict exclusion/51-and-52; cleanup.
`;

const requireEnv = (name) => {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required`);
  return value;
};
const loopbackOrigin = (value) => {
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol), "Endpoint must use HTTP(S)");
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "Only loopback API hosts are allowed");
  assert.ok(!url.username && !url.password && !url.search && !url.hash && url.pathname === "/", "Endpoint must be a bare origin without credentials, path, query, or fragment");
  return url.origin;
};
const identity = { contractId: "t8351-contract", environmentClass: "local-api-replay" };
const measurement = (expected = identity) => ({
  contract: { id: expected.contractId },
  environment: { class: expected.environmentClass },
  evidence: { synthetic: true, retained: "full source, not only identity" },
});
const at = (seconds) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000).toISOString();

// All 35 types are explicit; the independent contract fixture supplies names,
// not production-writer-derived types or IDs. Never send its fake field IDs.
const FIELD_TYPES = {
  "Run Key": "singleLineText", "Run ID": "singleLineText", "Run Attempt": "number",
  "Job ID": "singleLineText", Workflow: "singleLineText", "Teable EE Ref": "singleLineText",
  "Commit SHA": "singleLineText", "Case ID": "singleLineText", "Case Title": "singleLineText",
  Engine: "singleLineText", Result: "singleLineText", "Started At": "date", "Finished At": "date",
  "Duration Ms": "number", "Threshold Passed": "checkbox", "Primary Metric": "singleLineText",
  "Primary Metric Value": "number", "Primary Threshold": "number", "Trace Ref Count": "number",
  "Saved Trace Count": "number", "Failed Trace Count": "number", "Artifact Name": "singleLineText",
  "Artifact URL": "singleLineText", "Run URL": "singleLineText", "Trace URL": "singleLineText",
  "Manifest Path": "singleLineText", "Metrics JSON": "longText", "Thresholds JSON": "longText",
  "Phases JSON": "longText", "Trace Manifest JSON": "longText", "Summary Markdown": "longText",
  Error: "longText", "Measurement JSON": "longText", "Contract ID": "singleLineText",
  "Environment Class": "singleLineText",
};
const buildRecord = ({ caseId, runId, value = 100, seconds = 0, expected = identity, result = "pass", engine = "v2" }) =>
  buildPerformanceTrackResultRecord({
    payload: {
      caseId, title: `Synthetic ${caseId}`, engine, result, startedAt: at(seconds),
      finishedAt: at(seconds + 1), durationMs: value,
      thresholds: [{ metric: "duration_ms", actual: value, max: 100000, passed: result === "pass" }],
      metrics: { duration_ms: value }, phases: [{ name: "synthetic", durationMs: value }],
      ...(expected === null ? {} : { measurement: measurement(expected) }),
    },
    traceManifest: undefined,
    summaryMarkdown: "Synthetic local API acceptance fixture",
    context: { runId, runAttempt: "1", workflow: "t8351-local-api-replay" },
  });

const main = async () => {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return; }
  assert.equal(args.length, 0, "Unknown arguments; use --help (existing target tables are never accepted)");
  const endpoint = loopbackOrigin(requireEnv("T8351_API_ENDPOINT"));
  const baseId = requireEnv("T8351_API_BASE_ID");
  const token = requireEnv("T8351_API_TOKEN");
  assert.match(baseId, /^bse[a-zA-Z0-9]+$/, "Invalid local project ID");
  const nonce = randomUUID().replaceAll("-", "");
  const tableName = `t8351_api_replay_${nonce}`;
  const temporary = await mkdtemp(join(tmpdir(), "t8351-api-replay-"));
  let ownedTableId;
  let summary;
  // Both production adapters use global fetch. Enforce the same origin and
  // redirect policy for ALL real requests, including the backfill's internal
  // reads/PATCHes; no adapter is replaced or mocked.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    assert.equal(url.origin, endpoint, "Refusing a request outside the explicit loopback API origin");
    assert.ok(!url.username && !url.password, "URL credentials are forbidden");
    return realFetch(input, { ...init, redirect: "error", signal: init.signal ?? AbortSignal.timeout(30000) });
  };
  const request = async ({ method = "GET", path, body }) => {
    assert.ok(path.startsWith("/") && !path.startsWith("//"), "Invalid API request path");
    const response = await fetch(`${endpoint}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Local API ${method} failed with HTTP ${response.status}; response body withheld`);
    }
    if (response.status === 204) return undefined;
    const text = await response.text();
    const data = text ? JSON.parse(text) : undefined;
    assert.notEqual(data?.success, false, "Local API rejected request; response body withheld");
    return data;
  };
  try {
    assert.equal(PERFORMANCE_TRACK_CONTRACT_FIELDS.length, 35, "Review fixture field contract drift");
    assert.deepEqual(Object.keys(FIELD_TYPES).sort(), PERFORMANCE_TRACK_CONTRACT_FIELDS.map(({ name }) => name).sort(), "Every fixture field needs an explicit type");
    const definitions = PERFORMANCE_TRACK_CONTRACT_FIELDS.map(({ name }) => ({
      name, type: FIELD_TYPES[name],
      dbFieldName: name === "Contract ID" ? `identity_contract_${nonce.slice(0, 8)}`
        : name === "Environment Class" ? `identity_environment_${nonce.slice(0, 8)}`
          : ({ Result: "Status", "Run Key": "RunKeyLabel", "Duration Ms": "DurationNumber" }[name] ?? name.replaceAll(" ", "_")),
    }));
    const created = await request({ method: "POST", path: `/base/${baseId}/table`, body: { name: tableName, fields: definitions, records: [] } });
    // Record ownership immediately, even if later metadata assertions fail.
    assert.ok(created?.id && /^tbl[a-zA-Z0-9]+$/.test(created.id), "Create response lacks a valid owned table ID");
    ownedTableId = created.id;
    assert.equal(created.name, tableName, "Create response does not identify this fresh fixture");
    const tablePath = `/table/${ownedTableId}`;
    const adapter = createTeablePerformanceTrackAdapter({ request, tableId: ownedTableId });
    // A local PAT may cap reads below the reporter's 1000-row default; the
    // replay's own listRecords() already requires 100 per request.
    const writer = createPerformanceTrackRecordModule(adapter, { readPageSize: 100 });
    const contract = await writer.assertContract();
    assert.equal(contract.fieldNames.size, 35);
    const fields = await adapter.listFields();
    assert.equal(fields.length, 35, "Fixture must not gain default fields");
    const columns = resolvePerformanceTrackIdentityColumns(fields);
    assert.equal(columns.contractId, definitions.find(({ name }) => name === "Contract ID").dbFieldName);
    assert.equal(columns.environmentClass, definitions.find(({ name }) => name === "Environment Class").dbFieldName);
    assert.notEqual(columns.contractId, "Contract_ID");
    assert.notEqual(columns.environmentClass, "Environment_Class");
    const table = await request({ path: `/base/${baseId}/table/${ownedTableId}` });
    assert.equal(table.id, ownedTableId);
    assert.equal(table.name, tableName);
    const physical = table.dbTableName.split(".");
    assert.ok(physical.length === 1 || (physical.length === 2 && physical[0] === baseId), "Fixture physical table escaped its project");
    const sqlTableId = physical.at(-1);
    const listRecords = async () => {
      const rows = [];
      for (let skip = 0; ; skip += 100) {
        const data = await request({ path: `${tablePath}/record?fieldKeyType=name&take=100&skip=${skip}` });
        assert.ok(Array.isArray(data?.records), "Record list has no records array");
        rows.push(...data.records);
        if (data.records.length < 100) return rows;
      }
    };
    const fieldValues = (record, omitIdentity = false) => Object.fromEntries(fields
      .filter(({ name }) => !omitIdentity || !["Contract ID", "Environment Class"].includes(name))
      .map(({ name }) => [name, record.fields?.[name] ?? null]));
    const snapshot = async (omitIdentity = false) => (await listRecords())
      .map((record) => [record.id, fieldValues(record, omitIdentity)]).sort(([a], [b]) => a.localeCompare(b));
    assert.equal((await listRecords()).length, 0, "Fresh fixture must start empty");
    const readOne = async (id) => request({ path: `${tablePath}/record/${id}?fieldKeyType=name` });
    const assertIdentity = (record, expected, source) => {
      assert.equal(record.fields["Contract ID"] ?? null, expected?.contractId ?? null);
      assert.equal(record.fields["Environment Class"] ?? null, expected?.environmentClass ?? null);
      assert.equal(record.fields["Measurement JSON"] ?? null, source ?? null);
    };

    const initial = buildRecord({ caseId: "writer-only", runId: "writer-run" });
    const first = await writer.upsertResult(initial);
    assert.equal(first.action, "created");
    assertIdentity(await readOne(first.recordId), identity, initial.fields["Measurement JSON"]);
    const changedIdentity = { contractId: "changed-contract", environmentClass: "changed-environment" };
    const changed = buildRecord({ caseId: "writer-only", runId: "writer-run", expected: changedIdentity });
    const second = await writer.upsertResult(changed);
    assert.equal(second.action, "updated");
    assert.equal(second.recordId, first.recordId);
    assertIdentity(await readOne(first.recordId), changedIdentity, changed.fields["Measurement JSON"]);
    assert.equal((await writer.upsertResult(changed)).recordId, first.recordId);
    assert.equal((await listRecords()).length, 1, "Repeated reporter write created a duplicate");
    const cleared = buildRecord({ caseId: "writer-only", runId: "writer-run", expected: null });
    await writer.upsertResult(cleared);
    assertIdentity(await readOne(first.recordId), null, null);
    const batch = ["writer-batch-a", "writer-batch-b"].map((caseId) => buildRecord({ caseId, runId: "batch-run" }));
    const batchCreated = await writer.upsertResults({ records: batch, runId: "batch-run", runAttempt: 1 });
    assert.equal(batchCreated.created.length, 2);
    const batchUpdated = await writer.upsertResults({ records: batch, runId: "batch-run", runAttempt: 1 });
    assert.equal(batchUpdated.updated.length, 2);
    assert.equal(batchUpdated.created.length, 0);
    assert.equal((await listRecords()).length, 3, "Batch reporter write created duplicates");
    const partialWriterRows = [
      buildRecord({ caseId: "writer-contract-only", runId: "partial-writer-run", expected: { contractId: "writer-partial-contract" } }),
      buildRecord({ caseId: "writer-environment-only", runId: "partial-writer-run", expected: { environmentClass: "writer-partial-environment" } }),
    ];
    const partialWriterCreated = await writer.upsertResults({ records: partialWriterRows, runId: "partial-writer-run", runAttempt: 1 });
    assert.equal(partialWriterCreated.created.length, 2);
    for (let index = 0; index < partialWriterRows.length; index++) {
      const row = partialWriterRows[index];
      assertIdentity(await readOne(partialWriterCreated.created[index].recordId), {
        contractId: row.fields["Contract ID"] ?? null,
        environmentClass: row.fields["Environment Class"] ?? null,
      }, row.fields["Measurement JSON"]);
    }

    const history = [];
    const addHistory = (options) => history.push(buildRecord(options));
    for (const [caseId, count] of [["case-alpha", 65], ["case-52", 52], ["case-51", 51], ["case'quoted", 60]]) {
      for (let n = 1; n <= count; n++) addHistory({ caseId, runId: `history-${caseId}-${n}`, seconds: n, value: n + 10 });
    }
    // More than a page of newer mismatches: strict filtering MUST happen before
    // the per-case LIMIT or the older 60 matching points disappear entirely.
    for (let n = 1; n <= 70; n++) addHistory({
      caseId: "case-alpha", runId: `mismatch-${n}`, seconds: 1000 + n, value: 1000 + n,
      expected: n % 2 ? { ...identity, contractId: "wrong-contract" } : { ...identity, environmentClass: "wrong-environment" },
    });
    for (let n = 1; n <= 10; n++) addHistory({ caseId: "case-no-match", runId: `no-match-${n}`, seconds: 2000 + n, expected: { ...identity, contractId: "wrong-contract" } });
    for (const [index, override] of [
      { result: "fail" }, { engine: "v1" }, { value: 0 }, { value: -1 },
      { runId: "run-current" }, { caseId: "wrong-case" },
    ].entries()) addHistory({ caseId: "case-alpha", runId: `ineligible-${index}`, seconds: 3000 + index, value: 9000 + index, ...override });
    // Route every normal history row through the real reporter upsert, not a
    // raw record endpoint. Distinct run IDs keep repeated case history unique.
    for (const row of history) await writer.upsertResult(row);
    const historicalSource = JSON.stringify({ ...measurement(), evidence: { padding: "synthetic evidence ".repeat(40), untouched: true } }, null, 2);
    const legacy = [
      { "Measurement JSON": historicalSource },
      { "Measurement JSON": JSON.stringify(measurement()) },
      { "Measurement JSON": JSON.stringify(measurement()), "Contract ID": identity.contractId },
      { "Measurement JSON": "{not valid json" },
      { "Measurement JSON": JSON.stringify({ contract: { id: identity.contractId } }) },
      { "Measurement JSON": null },
    ].map((values, index) => ({ fields: { "Run Key": `legacy-${nonce}-${index}`, "Case ID": "migration-only", "Summary Markdown": `untouched legacy ${index}`, ...values } }));
    const legacyRows = await adapter.createRecords(legacy);
    const corpusEeCommit = "a".repeat(40);
    const corpusPerfCommit = "b".repeat(40);
    const partialCorpus = [
      { caseId: "corpus-contract-only", expected: { contractId: "contract-only-A", environmentClass: null }, value: 1 },
      ...Array.from({ length: 3 }, () => ({ caseId: "corpus-contract-only", expected: { contractId: "contract-only-B", environmentClass: null }, value: 100 })),
      { caseId: "corpus-environment-only", expected: { contractId: null, environmentClass: "environment-only-X" }, value: 2 },
      ...Array.from({ length: 3 }, () => ({ caseId: "corpus-environment-only", expected: { contractId: null, environmentClass: "environment-only-Y" }, value: 200 })),
    ];
    const partialCorpusRecords = partialCorpus.map(({ caseId, expected, value }, index) => ({ fields: {
      "Run Key": `partial-corpus-${nonce}-${index}`, "Run ID": `partial-corpus-run-${index}`,
      "Case ID": caseId, Engine: "v2", Result: "pass", "Started At": at(4000 + index),
      "Teable EE Ref": corpusEeCommit, "Commit SHA": corpusPerfCommit,
      "Primary Metric": "duration_ms", "Primary Metric Value": value,
      "Summary Markdown": `untouched partial corpus evidence ${index}`,
      // Historical reproduction: only JSON was written. There are deliberately
      // NO scalar identity keys; the migration must retain whichever component
      // exists without inventing the absent half of the identity pair.
      "Measurement JSON": JSON.stringify({
        ...(expected.contractId ? { contract: { id: expected.contractId } } : {}),
        ...(expected.environmentClass ? { environment: { class: expected.environmentClass } } : {}),
        evidence: { untouched: true, sample: index, padding: "partial historical evidence ".repeat(20) },
      }, null, 2),
    } }));
    const partialCorpusCreated = await adapter.createRecords(partialCorpusRecords);
    const quoteIdentifier = (value) => `"${value.replaceAll('"', '""')}"`;
    const physicalSqlTable = [baseId, sqlTableId].map(quoteIdentifier).join(".");
    const sqlRows = async (sql) => {
      const result = await request({ method: "POST", path: `/base/${baseId}/sql-query`, body: { sql } });
      assert.ok(Array.isArray(result?.rows), "SQL response has no rows array");
      return result.rows;
    };
    // Independent old JSON-grouped SQL, NOT derived from the scalar builder or
    // any model. duration_ms is intentionally not a substituted corpus metric.
    // Only the eight pinned corpus fixtures enter this query; invalid JSON in
    // other migration fixtures is not part of this historical corpus boundary.
    const oldCorpusSql = `SELECT c, e, r, p, m, k, h,
      percentile_disc(0.5) WITHIN GROUP (ORDER BY v) AS v, COUNT(*) AS n
      FROM (SELECT "Case_ID" AS c, "Engine" AS e,
        LEFT("Teable_EE_Ref", 12) AS r, LEFT("Commit_SHA", 12) AS p,
        "Primary_Metric" AS m, "Primary_Metric_Value" AS v,
        NULLIF("Measurement_JSON", '')::jsonb#>>'{contract,id}' AS k,
        NULLIF("Measurement_JSON", '')::jsonb#>>'{environment,class}' AS h
        FROM ${physicalSqlTable}
        WHERE "Status" = 'pass' AND "Engine" <> 'seed'
          AND LENGTH("Teable_EE_Ref") = 40) historical
      WHERE v > 0 GROUP BY c, e, r, p, m, k, h
      ORDER BY c, e, r, p, m, k NULLS FIRST, h NULLS FIRST`;
    const corpusCanonical = (rows) => rows.map(({ c, e, r, p, m, k, h, v, n }) =>
      JSON.stringify([c, e, r, p, m, k ?? null, h ?? null, Number(v), Number(n)])).sort();
    const expectedCorpusGroups = [
      { c: "corpus-contract-only", k: "contract-only-A", h: null, v: 1, n: 1 },
      { c: "corpus-contract-only", k: "contract-only-B", h: null, v: 100, n: 3 },
      { c: "corpus-environment-only", k: null, h: "environment-only-X", v: 2, n: 1 },
      { c: "corpus-environment-only", k: null, h: "environment-only-Y", v: 200, n: 3 },
    ].map((row) => ({ ...row, e: "v2", r: corpusEeCommit.slice(0, 12), p: corpusPerfCommit.slice(0, 12), m: "duration_ms" }));
    const oldCorpusRows = await sqlRows(oldCorpusSql);
    assert.deepEqual(corpusCanonical(oldCorpusRows), corpusCanonical(expectedCorpusGroups), "Historical JSON oracle must retain four independently specified partial-identity groups");
    const total = 5 + history.length + legacy.length + partialCorpusRecords.length;
    assert.equal((await listRecords()).length, total);
    const original = await snapshot();
    const businessBefore = await snapshot(true);

    // EXTERNAL FENCE: this process created the unpredictable table, never
    // registers report jobs, and has now awaited/drained EVERY fixture writer.
    // No writes except scalar migration occur until reconciliation completes.
    // The acknowledgement is not used as a substitute for that ownership fence.
    const migration = (mode, checkpointPath, extra = {}) => runIdentityBackfill({
      endpoint, baseId, tableId: ownedTableId, mode, checkpointPath,
      adapter: createIdentityBackfillHttpAdapter({ endpoint, token, baseId, tableId: ownedTableId }),
      pageSize: 17, maxRows: total + 1, maxBytes: 16 * 1024 * 1024,
      ...(mode === "apply" ? {
        acknowledgeWritersPausedAndDrained: true,
        fenceProvenance: `Fresh exclusively owned local replay fixture ${tableName}; all seed/report promises drained; no jobs registered`,
      } : {}),
      ...extra,
    });
    const plan = await migration("plan", join(temporary, "plan.json"));
    assert.equal(plan.complete, true);
    assert.equal(plan.updated, 0);
    assert.deepEqual(plan.counts, {
      "already-matching": 316, "valid-missing": 2, "partial-compatible": 1,
      conflict: 0, "invalid-json": 1, "missing-or-incomplete-identity": 13,
    });
    assert.deepEqual(await snapshot(), original, "Plan mutated fixture data");
    const applyPath = join(temporary, "apply.json");
    let applied = await migration("apply", applyPath, { maxRows: 2 });
    assert.equal(applied.complete, false);
    assert.equal(applied.stopped, "row-bound");
    assert.equal(applied.analyzed, 2);
    let invocations = 1;
    while (!applied.complete) {
      const previousCursor = applied.cursor;
      applied = await migration("apply", applyPath, { resume: true, maxRows: 47 });
      assert.ok(applied.cursor > previousCursor, "Resume made no bounded progress");
      assert.ok(applied.analyzed <= 47);
      invocations++;
    }
    assert.equal(applied.updated, 12, "Three complete identities plus nine available partial components must be filled");
    assert.deepEqual(applied.counts, plan.counts);
    assert.deepEqual(await snapshot(true), businessBefore, "Migration changed source JSON or another business field");
    for (let index = 0; index < 3; index++) {
      assertIdentity(await readOne(legacyRows[index].id), identity, legacy[index].fields["Measurement JSON"]);
    }
    assertIdentity(await readOne(legacyRows[4].id), { contractId: identity.contractId, environmentClass: null }, legacy[4].fields["Measurement JSON"]);
    for (let index = 0; index < partialCorpusCreated.length; index++) {
      assertIdentity(await readOne(partialCorpusCreated[index].id), partialCorpus[index].expected, partialCorpusRecords[index].fields["Measurement JSON"]);
    }
    for (let index = 0; index < partialWriterRows.length; index++) {
      const before = partialWriterRows[index];
      assertIdentity(await readOne(partialWriterCreated.created[index].recordId), {
        contractId: before.fields["Contract ID"] ?? null,
        environmentClass: before.fields["Environment Class"] ?? null,
      }, before.fields["Measurement JSON"]);
    }
    const afterApply = await snapshot();
    const completedResume = await migration("apply", applyPath, { resume: true, maxRows: 1 });
    assert.equal(completedResume.analyzed, 0);
    assert.equal(completedResume.updated, 12);
    const repeated = await migration("apply", join(temporary, "idempotence.json"));
    assert.equal(repeated.complete, true);
    assert.equal(repeated.updated, 0);
    assert.deepEqual(repeated.counts, { ...plan.counts, "already-matching": 319, "valid-missing": 0, "partial-compatible": 0 });
    assert.deepEqual(await snapshot(), afterApply, "Reconciliation was not idempotent");

    const scalarCorpusRows = await sqlRows(buildPerfCorpusPageSql({ table: physicalSqlTable, limit: 100, offset: 0, identityColumns: columns }));
    assert.deepEqual(corpusCanonical(scalarCorpusRows), corpusCanonical(oldCorpusRows), "Scalar corpus grouping changed old JSON-grouped values or counts");
    assert.deepEqual(corpusCanonical(scalarCorpusRows), corpusCanonical(expectedCorpusGroups));
    const orderedCorpus = (rows) => buildOrderedSeries({
      rows: rows.map(({ c, e, r, p, m, v }) => {
        assert.equal(r, corpusEeCommit.slice(0, 12));
        assert.equal(p, corpusPerfCommit.slice(0, 12));
        return { caseId: c, engine: e, commit: corpusEeCommit, metric: m, result: "pass", value: Number(v) };
      }),
      ordinals: { [corpusEeCommit]: 0 },
    });
    const oldOrderedCorpus = orderedCorpus(oldCorpusRows);
    const scalarOrderedCorpus = orderedCorpus(scalarCorpusRows);
    assert.equal(oldOrderedCorpus.series.get("corpus-contract-only::v2").points[0].value, 50.5);
    assert.equal(oldOrderedCorpus.series.get("corpus-environment-only::v2").points[0].value, 101);
    assert.deepEqual(scalarOrderedCorpus, oldOrderedCorpus, "Partial identities changed ordered corpus series");

    const caseIds = ["case-alpha", "case-52", "case-51", "case'quoted", "case-no-match", "case-empty"];
    const identityByCase = Object.fromEntries([...caseIds, "writer-contract-only", "writer-environment-only", "corpus-contract-only", "corpus-environment-only"].map((caseId) => [caseId, identity]));
    identityByCase["writer-contract-only"] = { contractId: "writer-partial-contract", environmentClass: identity.environmentClass };
    identityByCase["writer-environment-only"] = { contractId: identity.contractId, environmentClass: "writer-partial-environment" };
    identityByCase["corpus-contract-only"] = { contractId: "contract-only-A", environmentClass: identity.environmentClass };
    identityByCase["corpus-environment-only"] = { contractId: identity.contractId, environmentClass: "environment-only-X" };
    const expectedRows = (ids, strictOnly) => ids.flatMap((caseId) => history
      .map(({ fields: row }) => row)
      .filter((row) => row["Case ID"] === caseId && row.Result === "pass" && row.Engine === "v2"
        && row["Primary Metric Value"] > 0 && row["Run ID"] !== "run-current"
        && (!strictOnly || (row["Contract ID"] === identity.contractId && row["Environment Class"] === identity.environmentClass)))
      .sort((a, b) => Date.parse(b["Started At"]) - Date.parse(a["Started At"]))
      .slice(0, 60).map((row) => ({
        c: row["Case ID"], v: row["Primary Metric Value"], t: row["Started At"],
        k: row["Contract ID"] ?? null, h: row["Environment Class"] ?? null,
      })));
    const canonical = (rows) => rows.map(({ c, v, t, k, h }) => JSON.stringify([c, Number(v), Date.parse(t), k, h])).sort();
    let sqlQueries = 0;
    const queryHistory = async (ids, strictOnly) => {
      const sql = buildSameRunHistorySql({ caseIds: ids, currentRunId: "run-current", baseId, tableId: sqlTableId, identityColumns: columns, identityByCase, strictOnly });
      assert.ok(sql, "History builder unexpectedly omitted a configured query");
      const result = await request({ method: "POST", path: `/base/${baseId}/sql-query`, body: { sql } });
      assert.ok(Array.isArray(result?.rows), "SQL response has no rows array");
      for (const row of result.rows) assert.deepEqual(Object.keys(row).sort(), ["c", "h", "k", "t", "v"], "History must return scalar identities, not historical JSON");
      assert.deepEqual(canonical(result.rows), canonical(expectedRows(ids, strictOnly)), "Complete scalar history values differ from independently seeded expectations");
      sqlQueries++;
      return result.rows;
    };
    const legacyHistory = await queryHistory(caseIds, false);
    const strictHistory = await queryHistory(caseIds, true);
    for (const ids of [["case-alpha"], ["case-no-match"], ["case'quoted"]]) {
      await queryHistory(ids, false);
      await queryHistory(ids, true);
    }
    const incompleteStrict = await queryHistory(["writer-contract-only", "writer-environment-only", "corpus-contract-only", "corpus-environment-only"], true);
    assert.equal(incompleteStrict.length, 0, "An incomplete identity pair must never enter strict history");
    assert.equal(strictHistory.filter(({ c }) => c === "case-alpha").length, 60);
    assert.ok(strictHistory.every(({ k, h }) => k === identity.contractId && h === identity.environmentClass));
    const selected = comparableHistoryByCaseFromRows(rowsFromSqlResult(legacyHistory), {
      identityByCase, strictRows: rowsFromSqlResult(strictHistory),
    });
    assert.equal(selected.compatibilityByCase["case-51"].mode, "legacy-fallback");
    assert.equal(selected.compatibilityByCase["case-51"].strictPoints, 51);
    assert.equal(selected.compatibilityByCase["case-52"].mode, "strict");
    assert.equal(selected.compatibilityByCase["case-52"].strictPoints, 52);
    assert.equal(selected.compatibilityByCase["case-no-match"].mode, "legacy-fallback");
    assert.equal(selected.compatibilityByCase["case-no-match"].strictPoints, 0);
    assert.deepEqual(selected.valuesByCase["case-alpha"], Array.from({ length: 60 }, (_, index) => index + 16));
    summary = { fields: fields.length, records: total, writer: "PASS", plan: "PASS", migrationUpdates: applied.updated, boundedApplyInvocations: invocations, idempotence: "PASS", scalarSqlQueries: sqlQueries, corpusSqlQueries: 2, partialCorpusGroups: scalarCorpusRows.length, partialCorpusSeries: { contractOnly: 50.5, environmentOnly: 101 }, selection51And52: "PASS" };
  } finally {
    try {
      if (ownedTableId) {
        // Only the freshly returned table ID is ever used for destruction.
        await request({ method: "DELETE", path: `/base/${baseId}/table/${ownedTableId}/permanent` });
        const absent = await fetch(`${endpoint}/api/base/${baseId}/table/${ownedTableId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        await absent.body?.cancel();
        assert.equal(absent.status, 404, "Owned fixture remained accessible after permanent deletion");
      }
    } finally {
      globalThis.fetch = realFetch;
      await rm(temporary, { recursive: true, force: true });
    }
  }
  process.stdout.write(`PASS ${JSON.stringify({ ...summary, cleanup: "PASS" })}\n`);
};

main().catch((error) => {
  const token = process.env.T8351_API_TOKEN;
  // No stacks, HTTP response bodies, record payloads, or credentials in output.
  const message = error instanceof TypeError ? "Transport/configuration failure; details withheld" : String(error.message).split("\n")[0];
  process.stderr.write(`FAIL ${token ? message.replaceAll(token, "[redacted]") : message}\n`);
  process.exitCode = 1;
});
