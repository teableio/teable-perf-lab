import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { buildSameRunHistorySql, rowsFromSqlResult } from "./resolve-same-run-history.mjs";
import { buildSameRunComparison, comparableHistoryByCaseFromRows } from "./same-run-comparison-model.mjs";

// Only disposable, local PostgreSQL is accepted. No Teable/API credentials used.
const databaseUrl = process.env.SAME_RUN_HISTORY_PG_URL;
assert.ok(databaseUrl, "Set SAME_RUN_HISTORY_PG_URL to a disposable local PostgreSQL database");
const url = new URL(databaseUrl);
assert.ok(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Only loopback PostgreSQL hosts are allowed");
assert.equal(url.search, "", "Connection query options are not accepted");
const schema = `history_query_check_${process.pid}_${randomUUID().replaceAll("-", "")}`;
let created = false;
const table = `"${schema}"."history"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const psql = (sql) => execFileSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], {
  env: {
    ...process.env,
    PGHOST: url.hostname.replaceAll(/[\[\]]/g, ""),
    PGPORT: url.port || "5432",
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
    PGUSER: url.username ? decodeURIComponent(url.username) : (process.env.PGUSER ?? ""),
    PGPASSWORD: url.password ? decodeURIComponent(url.password) : "",
    PGTZ: "UTC", // Fixture timestamp literals and expected instants use UTC.
  },
  encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
}).trim();
const jsonQuery = (sql) => JSON.parse(psql(sql));
const outputArgument = process.argv.indexOf("--output");
const outputPath = outputArgument < 0 ? undefined : process.argv[outputArgument + 1];
if (outputArgument >= 0) {
  assert.ok(outputPath && !outputPath.startsWith("--"), "--output requires a JSONL file path");
  writeFileSync(outputPath, "");
}

// Frozen pre-change implementation: do not derive this oracle from the new SQL.
const oldSql = ({ caseIds, currentRunId, perCase = 60, includeMeasurement = false, identityByCase = {}, strictOnly = false }) => {
  const ids = [...new Set(caseIds.filter(Boolean))];
  if (!ids.length) return undefined;
  const clauses = ids.flatMap((id) => {
    const identity = identityByCase[id];
    return identity?.contractId && identity?.environmentClass
      ? [`("Case_ID" = ${literal(id)} AND NULLIF("Measurement_JSON", '')::jsonb#>>'{contract,id}' = ${literal(identity.contractId)} AND NULLIF("Measurement_JSON", '')::jsonb#>>'{environment,class}' = ${literal(identity.environmentClass)})`]
      : [];
  });
  if (strictOnly && (!includeMeasurement || !clauses.length)) return undefined;
  return `SELECT c, v, t, j FROM (SELECT "Case_ID" AS c, "Primary_Metric_Value" AS v, "Started_At" AS t, ${includeMeasurement ? '"Measurement_JSON"' : "NULL"} AS j, row_number() OVER (PARTITION BY "Case_ID" ORDER BY "Started_At" DESC) AS rn FROM ${table} WHERE "Status" = 'pass' AND "Engine" = 'v2' AND "Primary_Metric_Value" > 0 AND "Case_ID" IN (${ids.map(literal).join(", ")})${currentRunId ? ` AND "Run_ID" <> ${literal(currentRunId)}` : ""}${strictOnly ? ` AND (${clauses.join(" OR ")})` : ""}) x WHERE rn <= ${Number(perCase)}`;
};
const referenceSql = (options) => oldSql({ ...options, includeMeasurement: true });
const newSql = (options) => buildSameRunHistorySql({ ...options, baseId: schema, tableId: "history" });
const readRows = (sql) => sql ? jsonQuery(`SELECT COALESCE(json_agg(x), '[]'::json) FROM (${sql}) x`) : [];
const referenceRows = (rows) => rows.map(({ c, v, t, j }) => {
  const measurement = j ? JSON.parse(j) : null;
  return { c, v, t, k: measurement?.contract?.id ?? null, h: measurement?.environment?.class ?? null };
});
// Compare logical data, not the obsolete long JSON projection or SQL spelling.
const normalized = (rows) => rows.map(({ c, v, t, k, h }) => JSON.stringify([c, v, t, k, h])).sort();
const compare = (options) => {
  const before = referenceRows(readRows(referenceSql(options)));
  const after = readRows(newSql(options));
  assert.deepEqual(normalized(after), normalized(before), `Complete logical row mismatch: ${JSON.stringify(options)}`);
  return after;
};
// This fixture backfill intentionally derives the new columns from historical
// synthetic JSON, including independent NULL/incomplete keys; it is not a
// test of the production backfill runner.
const backfillFixture = () => psql(`UPDATE ${table} SET
  "Contract_ID" = NULLIF("Measurement_JSON", '')::jsonb#>>'{contract,id}',
  "Environment_Class" = NULLIF("Measurement_JSON", '')::jsonb#>>'{environment,class}'; ANALYZE ${table}`);
const identity = { contractId: "contract-neutral", environmentClass: "local-disposable" };
const caseIds = ["case-alpha", "case-beta", "case-scarce", "case-no-identity", "case'quoted", "case-empty", "case-no-eligible"];
const identityByCase = Object.fromEntries(caseIds.filter((id) => id !== "case-no-identity").map((id) => [id, identity]));
const common = { caseIds, currentRunId: "run-current", identityByCase };
const assertModelEquivalent = (options) => {
  const model = (query, adapt) => comparableHistoryByCaseFromRows(rowsFromSqlResult(adapt(readRows(query({ ...options, strictOnly: false })))), {
    identityByCase: options.identityByCase,
    strictRows: rowsFromSqlResult(adapt(readRows(query({ ...options, strictOnly: true })))),
  });
  const before = model(referenceSql, referenceRows);
  const after = model(newSql, (rows) => rows);
  assert.deepEqual(after, before);
  const payloads = options.caseIds.map((caseId) => ({ caseId, engine: "v2", result: "pass", thresholds: [{ metric: "duration_ms", actual: 100, max: 1000 }] }));
  const result = (history) => buildSameRunComparison({ payloads, historyByCase: history.valuesByCase, historyCompatibilityByCase: history.compatibilityByCase });
  assert.deepEqual(result(after), result(before));
  return after;
};

try {
  psql(`CREATE SCHEMA "${schema}"`);
  created = true;
  psql(`CREATE TABLE ${table} (
    "Case_ID" text, "Primary_Metric_Value" double precision, "Started_At" timestamptz,
    "Measurement_JSON" text, "Status" text, "Engine" text, "Run_ID" text,
    ${Array.from({ length: 26 }, (_, index) => `"Neutral_${index}" text`).join(", ")},
    "Contract_ID" text, "Environment_Class" text
  )`);
  // Recent ineligible rows outnumber the cap. NULL timestamp has PostgreSQL's
  // existing DESC/NULLS FIRST semantics; all other timestamps are unique.
  psql(`INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
    SELECT c, CASE WHEN variant = 3 THEN NULL WHEN variant = 4 THEN 0 WHEN variant = 5 THEN -1 ELSE n END,
      CASE WHEN variant = 0 AND n = 1 THEN NULL ELSE '2026-01-01'::timestamptz + (n + variant * 1000) * interval '1 second' END,
      CASE WHEN variant = 8 THEN NULL WHEN variant = 9 THEN ''
        WHEN variant = 14 THEN '{}' WHEN variant = 15 THEN 'null'
        WHEN variant = 16 THEN '{"contract":{"id":"contract-neutral"}}'
        WHEN variant = 17 THEN '{"environment":{"class":"local-disposable"}}'
        ELSE jsonb_build_object(
          'contract', jsonb_build_object('id', CASE WHEN variant = 6 OR c = 'case-no-eligible' THEN 'wrong-contract' ELSE 'contract-neutral' END),
          'environment', jsonb_build_object('class', CASE WHEN variant = 7 THEN 'wrong-environment' ELSE 'local-disposable' END),
          'sample', n, 'case', c)::text END,
      CASE WHEN variant = 1 THEN 'fail' WHEN variant = 11 THEN NULL ELSE 'pass' END,
      CASE WHEN variant = 2 THEN 'v1' WHEN variant = 12 THEN NULL ELSE 'v2' END,
      CASE WHEN variant = 10 THEN 'run-current' WHEN variant = 13 THEN NULL ELSE 'run-history' END
    FROM unnest(ARRAY['case-alpha', 'case-beta', 'case-scarce', 'case-no-identity', 'case''quoted', 'case-no-eligible']) c
    CROSS JOIN generate_series(1, 95) n CROSS JOIN generate_series(0, 17) variant
    WHERE c <> 'case-scarce' OR n <= 8`);
  backfillFixture();
  const strict = compare({ ...common, strictOnly: true });
  assert.deepEqual(Object.fromEntries(caseIds.map((id) => [id, strict.filter((row) => row.c === id).length])), {
    "case-alpha": 60, "case-beta": 60, "case-scarce": 8, "case-no-identity": 0,
    "case'quoted": 60, "case-empty": 0, "case-no-eligible": 0,
  });
  assert.ok(strict.every((row) => row.k === identity.contractId && row.h === identity.environmentClass));
  assert.ok(strict.some((row) => row.t === null));
  const mixed = compare({ ...common, perCase: 120 });
  assert.ok(mixed.some((row) => row.k === null && row.h === identity.environmentClass));
  assert.ok(mixed.some((row) => row.k === identity.contractId && row.h === null));
  for (const strictOnly of [false, true]) {
    for (const perCase of [0, -2, 1, 2.9, 60, 120]) compare({ ...common, strictOnly, perCase });
  }
  compare({ ...common, currentRunId: undefined });
  compare({ ...common, caseIds: ["case-alpha", "case-alpha", "case'quoted"] });
  compare({ ...common, caseIds: [] });
  compare({ ...common, identityByCase: {}, strictOnly: true });
  compare({ ...common, identityByCase: { "case-alpha": { contractId: identity.contractId } }, strictOnly: true });
  assertModelEquivalent(common);

  // Older matching rows must remain accessible beyond the legacy top 60.
  psql(`TRUNCATE ${table}; INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
    SELECT 'case-alpha', n, '2026-01-01'::timestamptz + n * interval '1 second',
      jsonb_build_object('contract', jsonb_build_object('id', CASE WHEN n <= 60 THEN 'contract-neutral' ELSE 'wrong-contract' END), 'environment', jsonb_build_object('class', 'local-disposable'))::text,
      'pass', 'v2', 'run-history' FROM generate_series(1, 160) n`);
  backfillFixture();
  const olderHistory = assertModelEquivalent({ ...common, caseIds: ["case-alpha"] });
  assert.equal(olderHistory.compatibilityByCase["case-alpha"].mode, "strict");
  assert.deepEqual(olderHistory.valuesByCase["case-alpha"], Array.from({ length: 60 }, (_, index) => index + 1));

  // Identical logical projections permit complete equality even across ties.
  psql(`TRUNCATE ${table}; INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
    SELECT 'case-alpha', 42, '2026-01-01'::timestamptz, '{"contract":{"id":"contract-neutral"},"environment":{"class":"local-disposable"}}', 'pass', 'v2', 'run-history' FROM generate_series(1, 65)`);
  backfillFixture();
  assert.equal(compare({ ...common, strictOnly: true }).length, 60);

  // A non-identical cutoff tie has no promised winner. Check exact quota,
  // complete identities, timestamps, newer prefix, and admissible tied values.
  psql(`TRUNCATE ${table};
    INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
      SELECT 'case-tie', n, '2026-02-01'::timestamptz, '{"contract":{"id":"contract-neutral"},"environment":{"class":"local-disposable"}}', 'pass', 'v2', 'run-history' FROM generate_series(1, 5) n;
    INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
      SELECT 'case-tie', 100 + n, '2026-03-01'::timestamptz + n * interval '1 second', '{"contract":{"id":"contract-neutral"},"environment":{"class":"local-disposable"}}', 'pass', 'v2', 'run-history' FROM generate_series(1, 3) n`);
  backfillFixture();
  for (const strictOnly of [false, true]) {
    for (const perCase of [1, 2, 4, 5, 8]) {
      const options = { caseIds: ["case-tie"], currentRunId: "run-current", identityByCase: { "case-tie": identity }, strictOnly, perCase };
      for (const rows of [referenceRows(readRows(referenceSql(options))), readRows(newSql(options))]) {
        assert.equal(rows.length, perCase);
        const values = rows.map((row) => row.v);
        assert.equal(new Set(values).size, perCase);
        assert.ok(rows.every((row) => row.c === "case-tie" && row.k === identity.contractId && row.h === identity.environmentClass));
        const newerValues = [101, 102, 103];
        assert.ok(values.every((value) => (value >= 1 && value <= 5) || newerValues.includes(value)));
        const expectedNewer = Math.min(newerValues.length, perCase);
        assert.deepEqual(values.filter((value) => newerValues.includes(value)).sort(), newerValues.slice(-expectedNewer));
        assert.equal(values.filter((value) => value <= 5).length, perCase - expectedNewer);
        for (const row of rows) {
          const expected = row.v <= 5 ? Date.parse("2026-02-01T00:00:00Z") : Date.parse("2026-03-01T00:00:00Z") + (row.v - 100) * 1000;
          assert.equal(Date.parse(row.t), expected);
        }
      }
    }
  }
  console.log("PostgreSQL complete-logical-row and model history equivalence checks passed");

  if (process.argv.includes("--perf")) {
    const originalCases = Array.from({ length: 8 }, (_, index) => `perf-${index}`);
    const eligibilityCases = ["old-matching", "wrong-identity", "scarce-identity", "dense", "all-fail", "all-v1", "all-current", "scarce-pass", "scarce-v2", "scarce-history", "null-status", "null-engine", "all-zero", "scarce-positive", "null-run", "dense-other"];
    const profiles = [
      { name: "original-eight", cases: originalCases, sampleCases: originalCases },
      { name: "eligibility-skew", cases: eligibilityCases, sampleCases: ["all-fail", "all-v1", "all-current", "scarce-pass", "scarce-v2", "scarce-history", "dense", "absent"] },
    ];
    const explain = (sql) => jsonQuery(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)[0];
    const nodes = (plan) => [plan, ...(plan.Plans ?? []).flatMap(nodes)];
    const rootBuffers = (plan) => (plan.Plan["Shared Hit Blocks"] ?? 0) + (plan.Plan["Shared Read Blocks"] ?? 0);
    const indexesUsed = (plan) => [...new Set(nodes(plan.Plan).map((node) => node["Index Name"]).filter(Boolean))];
    const median = (values) => {
      const sorted = [...values].sort((a, b) => a - b);
      return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.floor(sorted.length / 2)]) / 2;
    };
    const statistics = (values) => ({ raw: values, median: median(values), p95: [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] });
    psql(`CREATE INDEX history_started_at ON ${table} ("Started_At")`);
    for (const profile of profiles) {
      // Each profile has the same 631872 rows and 33+2 user columns. The
      // original eight-case data is unchanged; absent is a query-only target.
      // Eligibility skew is separate, not a replacement that hides a bad plan.
      psql(`DROP INDEX IF EXISTS "${schema}".history_identity_ordered, "${schema}".history_case_ordered, "${schema}".history_identity_eligibility, "${schema}".history_case_eligibility; TRUNCATE ${table}`);
      if (profile.name === "original-eight") {
        psql(`INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID", "Neutral_0")
          SELECT 'perf-' || (n % 8), n, '2026-01-01'::timestamptz + n * interval '1 second',
            jsonb_build_object('contract', jsonb_build_object('id', CASE
              WHEN n % 8 = 0 AND n > 640 THEN 'wrong-contract'
              WHEN n % 8 = 1 THEN 'wrong-contract'
              WHEN n % 8 = 2 AND n > 64 THEN 'wrong-contract'
              WHEN n % 8 NOT IN (0, 1, 2) AND n % 11 = 0 THEN 'wrong-contract'
              ELSE 'contract-neutral' END), 'environment', jsonb_build_object('class', 'local-disposable'), 'padding', repeat(md5(n::text), 8))::text,
            CASE WHEN n % 19 = 0 THEN 'fail' ELSE 'pass' END, CASE WHEN n % 23 = 0 THEN 'v1' ELSE 'v2' END,
            CASE WHEN n % 29 = 0 THEN 'run-current' ELSE 'run-history' END, repeat(md5(n::text), 8)
          FROM generate_series(1, 631872) n`);
      } else {
        psql(`INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID", "Neutral_0")
          SELECT (ARRAY[${eligibilityCases.map(literal).join(", ")}])[n % 16 + 1],
            CASE WHEN n % 16 = 12 OR (n % 16 = 13 AND n > 128) THEN 0 ELSE n END,
            '2026-01-01'::timestamptz + n * interval '1 second',
            jsonb_build_object('contract', jsonb_build_object('id', CASE
              WHEN (n % 16 = 0 AND n > 1280) OR n % 16 = 1 OR (n % 16 = 2 AND n > 128) THEN 'wrong-contract'
              ELSE 'contract-neutral' END), 'environment', jsonb_build_object('class', 'local-disposable'), 'padding', repeat(md5(n::text), 8))::text,
            CASE WHEN n % 16 = 4 OR (n % 16 = 7 AND n > 128) THEN 'fail' WHEN n % 16 = 10 THEN NULL ELSE 'pass' END,
            CASE WHEN n % 16 = 5 OR (n % 16 = 8 AND n > 128) THEN 'v1' WHEN n % 16 = 11 THEN NULL ELSE 'v2' END,
            CASE WHEN n % 16 = 6 OR (n % 16 = 9 AND n > 128) THEN 'run-current' WHEN n % 16 = 14 THEN NULL ELSE 'run-history' END,
            repeat(md5(n::text), 8)
          FROM generate_series(1, 631872) n`);
      }
      backfillFixture();
      const fixtureCounts = readRows(`SELECT "Case_ID" AS c, COUNT(*)::integer AS n FROM ${table} GROUP BY "Case_ID"`);
      assert.equal(fixtureCounts.reduce((sum, row) => sum + row.n, 0), 631872);
      assert.ok(fixtureCounts.every((row) => row.n === 631872 / profile.cases.length));
      const rangeCounts = readRows(`SELECT "Case_ID" AS c, "Contract_ID" AS k, "Environment_Class" AS h, COUNT(*)::integer AS n FROM ${table} WHERE "Engine" = 'v2' AND "Status" = 'pass' GROUP BY 1, 2, 3`);
      const targets = [...profile.cases, "absent"];
      const options = { ...common, caseIds: profile.sampleCases, identityByCase: Object.fromEntries(targets.map((id) => [id, identity])) };
      const expectedCount = (caseId, strictOnly) => {
        if (caseId === "absent") return 0;
        if (profile.name === "original-eight") return strictOnly && caseId === "perf-1" ? 0 : strictOnly && caseId === "perf-2" ? 7 : 60;
        if (["all-fail", "all-v1", "all-current", "null-status", "null-engine", "all-zero", "null-run"].includes(caseId)) return 0;
        if (["scarce-pass", "scarce-v2", "scarce-history", "scarce-positive"].includes(caseId)) return 8;
        return strictOnly && caseId === "wrong-identity" ? 0 : strictOnly && caseId === "scarce-identity" ? 8 : 60;
      };
      const checkRows = (queryOptions) => {
        const rows = compare(queryOptions);
        for (const caseId of queryOptions.caseIds) assert.equal(rows.filter((row) => row.c === caseId).length, expectedCount(caseId, queryOptions.strictOnly), `${profile.name}/${caseId}/strict=${queryOptions.strictOnly}`);
        return rows;
      };
      const describeScope = (plan, ids, strictOnly) => {
        const expectedIndex = strictOnly ? "history_identity_eligibility" : "history_case_eligibility";
        const scans = nodes(plan.Plan).filter((node) => node["Relation Name"] === "history" && /Scan/.test(node["Node Type"]));
        const scannedRowsApprox = scans.reduce((sum, node) => sum + ((node["Actual Rows"] ?? 0) + (node["Rows Removed by Filter"] ?? 0) + (node["Rows Removed by Index Recheck"] ?? 0)) * (node["Actual Loops"] ?? 0), 0);
        // EXPLAIN rounds per-loop means. Three counters each round by <=0.5.
        const roundingAllowance = scans.reduce((sum, node) => sum + ((node["Actual Loops"] ?? 0) > 1 ? 1.5 * node["Actual Loops"] : 0), 0);
        const equalityRangeRows = rangeCounts.filter((row) => ids.includes(row.c) && (!strictOnly || (row.k === identity.contractId && row.h === identity.environmentClass))).reduce((sum, row) => sum + row.n, 0);
        const scopedIndexes = scans.length > 0 && scans.every((node) => node["Index Name"] === expectedIndex || (node["Node Type"] === "Bitmap Heap Scan" && nodes(node).some((child) => child["Index Name"] === expectedIndex)));
        return { caseIds: ids, returnedRows: plan.Plan["Actual Rows"], scannedRowsApprox, roundingAllowance, equalityRangeRows,
          rootSharedBlocks: rootBuffers(plan), indexesUsed: indexesUsed(plan), scopedIndexes,
          withinEqualityRange: scannedRowsApprox <= equalityRangeRows + roundingAllowance,
          scans: scans.map((node) => ({ index: node["Index Name"], indexCondition: node["Index Cond"], filter: node.Filter, actualRows: node["Actual Rows"], removedByFilter: node["Rows Removed by Filter"] ?? 0, loops: node["Actual Loops"] })) };
      };
      for (const indexMode of ["started-at-only", "eligibility-prefix"]) {
        const candidate = indexMode === "eligibility-prefix";
        if (candidate) psql(`
          CREATE INDEX history_identity_ordered ON ${table} ("Case_ID", "Contract_ID", "Environment_Class", "Started_At" DESC);
          CREATE INDEX history_case_ordered ON ${table} ("Case_ID", "Started_At" DESC);
          CREATE INDEX history_identity_eligibility ON ${table} ("Case_ID", "Contract_ID", "Environment_Class", "Engine", "Status", "Started_At" DESC);
          CREATE INDEX history_case_eligibility ON ${table} ("Case_ID", "Engine", "Status", "Started_At" DESC); ANALYZE ${table}`);
        for (const strictOnly of [false, true]) {
          checkRows({ ...options, strictOnly });
          const queries = { oldJson: referenceSql({ ...options, strictOnly }), newScalar: newSql({ ...options, strictOnly }) };
          for (const sql of Object.values(queries)) explain(sql);
          const samples = { oldJson: [], newScalar: [] };
          for (let repeat = 0; repeat < 6; repeat++) {
            for (const label of repeat % 2 ? ["newScalar", "oldJson"] : ["oldJson", "newScalar"]) samples[label].push(explain(queries[label]));
          }
          const summary = Object.fromEntries(Object.entries(samples).map(([label, plans]) => [label, {
            executionMs: statistics(plans.map((plan) => plan["Execution Time"])),
            sharedHitBlocks: statistics(plans.map((plan) => plan.Plan["Shared Hit Blocks"] ?? 0)),
            sharedReadBlocks: statistics(plans.map((plan) => plan.Plan["Shared Read Blocks"] ?? 0)),
            rootSharedBlocks: statistics(plans.map(rootBuffers)),
            tempReadBlocks: statistics(plans.map((plan) => plan.Plan["Temp Read Blocks"] ?? 0)),
            tempWrittenBlocks: statistics(plans.map((plan) => plan.Plan["Temp Written Blocks"] ?? 0)),
            indexesUsed: plans.map(indexesUsed),
          }]));
          const scopePlans = [];
          if (candidate) {
            // Include every singleton and <=8-target batches, plus a mixed
            // original-data batch with an absent case but no fixture changes.
            const targetSets = [...targets.map((id) => [id]), ["absent", ...profile.cases.slice(0, 7)]];
            for (let start = 0; start < targets.length; start += 8) targetSets.push(targets.slice(start, start + 8));
            for (const ids of targetSets) {
              const queryOptions = { ...options, caseIds: ids, strictOnly };
              checkRows(queryOptions);
              scopePlans.push({ caseIds: ids, plan: explain(newSql(queryOptions)) });
            }
          }
          const sampleScopes = candidate ? samples.newScalar.map((plan) => describeScope(plan, options.caseIds, strictOnly)) : [];
          const scopeSummary = scopePlans.map(({ caseIds: ids, plan }) => describeScope(plan, ids, strictOnly));
          const allScopes = [...sampleScopes, ...scopeSummary];
          const bufferDecrease = summary.newScalar.rootSharedBlocks.median < summary.oldJson.rootSharedBlocks.median;
          const scopedAccess = allScopes.every((entry) => entry.scopedIndexes && entry.withinEqualityRange);
          const rootReductionRequired = profile.name === "original-eight";
          const comparisonDeltas = {
            rootSharedBlocks: summary.newScalar.rootSharedBlocks.median - summary.oldJson.rootSharedBlocks.median,
            medianExecutionMs: summary.newScalar.executionMs.median - summary.oldJson.executionMs.median,
            p95ExecutionMs: summary.newScalar.executionMs.p95 - summary.oldJson.executionMs.p95,
            tempReadBlocks: summary.newScalar.tempReadBlocks.median - summary.oldJson.tempReadBlocks.median,
            tempWrittenBlocks: summary.newScalar.tempWrittenBlocks.median - summary.oldJson.tempWrittenBlocks.median,
          };
          // Explicit review decision: the unchanged primary workload must
          // reduce root buffers. Adversarial eligibility cases must preserve
          // results and equality-range access, not universally improve time or
          // buffers. Residual predicates can exhaust each range and revisit
          // heap pages that the old bitmap/window path reads only once.
          // Always retain those regressions; never tune fixture values away.
          const report = { profile: profile.name, indexMode, strictOnly, rows: 631872, oldFields: 33, addedScalarFields: 2, fields: 35, fixtureCounts,
            warmups: 1, repetitions: 6, interleaved: true, plannerForced: false,
            performancePolicy: "primary-workload-vs-adversarial-scope",
            comparisonDeltas,
            regressions: Object.entries(comparisonDeltas).filter(([, delta]) => delta > 0).map(([metric]) => metric),
            performanceAcceptance: candidate ? { rootReductionRequired, bufferDecrease, scopedAccess, passed: scopedAccess && (!rootReductionRequired || bufferDecrease) } : null,
            // Run_ID <> current and value > 0 are residual predicates. Work is
            // bounded by the real equality range, not universally by quota 60.
            summary, sampleScopes, scopeSummary };
          appendFileSync(outputPath ?? 1, `${JSON.stringify({ ...report, samples, scopePlans })}\n`);
          if (outputPath) appendFileSync(1, `${JSON.stringify({ ...report, rawPlansPath: outputPath })}\n`);
          if (candidate) {
            if (rootReductionRequired) assert.ok(bufferDecrease, `${profile.name}: candidate must reduce root shared hit+read buffers`);
            assert.ok(scopedAccess, `${profile.name}: both modes must use equality-scoped indexes, not repeated global history scans`);
          }
        }
      }
    }
  }
} finally {
  if (created) psql(`DROP SCHEMA "${schema}" CASCADE`);
}
