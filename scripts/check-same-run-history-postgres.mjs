import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { buildSameRunHistorySql } from "./resolve-same-run-history.mjs";

// Only disposable, local PostgreSQL is accepted. No Teable/API credentials used.
const databaseUrl = process.env.SAME_RUN_HISTORY_PG_URL;
assert.ok(
  databaseUrl,
  "Set SAME_RUN_HISTORY_PG_URL to a disposable local PostgreSQL database",
);
const url = new URL(databaseUrl);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname),
  "Only loopback PostgreSQL hosts are allowed",
);
assert.equal(url.search, "", "Connection query options are not accepted");
const schema = `history_query_check_${process.pid}_${randomUUID().replaceAll("-", "")}`;
let created = false;
const table = `"${schema}"."history"`;
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
const psql = (sql) =>
  execFileSync("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", "-c", sql], {
    env: {
      ...process.env,
      PGHOST: url.hostname.replaceAll(/[\[\]]/g, ""),
      PGPORT: url.port || "5432",
      PGDATABASE: decodeURIComponent(url.pathname.slice(1)),
      PGUSER: url.username
        ? decodeURIComponent(url.username)
        : (process.env.PGUSER ?? ""),
      PGPASSWORD: url.password ? decodeURIComponent(url.password) : "",
    },
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const jsonQuery = (sql) => JSON.parse(psql(sql));

// Frozen pre-change implementation: do not derive this oracle from the new SQL.
const oldSql = ({
  caseIds,
  currentRunId,
  perCase = 60,
  includeMeasurement = false,
  identityByCase = {},
  strictOnly = false,
}) => {
  const ids = [...new Set(caseIds.filter(Boolean))];
  if (!ids.length) return undefined;
  const clauses = ids.flatMap((id) => {
    const identity = identityByCase[id];
    return identity?.contractId && identity?.environmentClass
      ? [
          `("Case_ID" = ${literal(id)} AND NULLIF("Measurement_JSON", '')::jsonb#>>'{contract,id}' = ${literal(identity.contractId)} AND NULLIF("Measurement_JSON", '')::jsonb#>>'{environment,class}' = ${literal(identity.environmentClass)})`,
        ]
      : [];
  });
  if (strictOnly && (!includeMeasurement || !clauses.length)) return undefined;
  return `SELECT c, v, t, j FROM (SELECT "Case_ID" AS c, "Primary_Metric_Value" AS v, "Started_At" AS t, ${includeMeasurement ? '"Measurement_JSON"' : "NULL"} AS j, row_number() OVER (PARTITION BY "Case_ID" ORDER BY "Started_At" DESC) AS rn FROM ${table} WHERE "Status" = 'pass' AND "Engine" = 'v2' AND "Primary_Metric_Value" > 0 AND "Case_ID" IN (${ids.map(literal).join(", ")})${currentRunId ? ` AND "Run_ID" <> ${literal(currentRunId)}` : ""}${strictOnly ? ` AND (${clauses.join(" OR ")})` : ""}) x WHERE rn <= ${Number(perCase)}`;
};
const newSql = (options) =>
  buildSameRunHistorySql({ ...options, baseId: schema, tableId: "history" });
const readRows = (sql) =>
  sql
    ? jsonQuery(`SELECT COALESCE(json_agg(x), '[]'::json) FROM (${sql}) x`)
    : [];
const normalized = (rows) =>
  rows.map((row) => JSON.stringify([row.c, row.v, row.t, row.j])).sort();
const compare = (options) => {
  const before = readRows(oldSql(options));
  let after;
  for (const branched of [undefined, false, true]) {
    after = readRows(newSql({ ...options, branched }));
    assert.deepEqual(
      normalized(after),
      normalized(before),
      `Complete row mismatch: ${JSON.stringify({ ...options, branched })}`,
    );
  }
  return after;
};
const identity = {
  contractId: "contract-neutral",
  environmentClass: "local-disposable",
};
const caseIds = [
  "case-alpha",
  "case-beta",
  "case-scarce",
  "case-no-identity",
  "case'quoted",
  "case-empty",
];
const identityByCase = Object.fromEntries(
  caseIds.filter((id) => id !== "case-no-identity").map((id) => [id, identity]),
);
const common = {
  caseIds,
  currentRunId: "run-current",
  includeMeasurement: true,
  identityByCase,
};

try {
  psql(`CREATE SCHEMA "${schema}"`);
  created = true;
  psql(`CREATE TABLE ${table} (
    "Case_ID" text, "Primary_Metric_Value" double precision, "Started_At" timestamptz,
    "Measurement_JSON" text, "Status" text, "Engine" text, "Run_ID" text,
    ${Array.from({ length: 26 }, (_, index) => `"Neutral_${index}" text`).join(", ")}
  )`);
  // Recent ineligible rows outnumber the cap; applying LIMIT before any filter
  // loses old eligible rows. JSON variants cover NULL, empty, wrong, and
  // missing identity keys.
  psql(`INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
    SELECT c, CASE WHEN variant = 3 THEN NULL WHEN variant = 4 THEN 0 WHEN variant = 5 THEN -1 ELSE n END,
      CASE WHEN variant = 0 AND n = 1 THEN NULL ELSE '2026-01-01'::timestamptz + (n + variant * 1000) * interval '1 second' END,
      CASE WHEN variant = 8 THEN NULL WHEN variant = 9 THEN ''
        WHEN variant = 14 THEN '{}' WHEN variant = 15 THEN 'null'
        WHEN variant = 16 THEN '{"contract":{"id":"contract-neutral"}}'
        ELSE jsonb_build_object(
        'contract', jsonb_build_object('id', CASE WHEN variant = 6 THEN 'wrong-contract' ELSE 'contract-neutral' END),
        'environment', jsonb_build_object('class', CASE WHEN variant = 7 THEN 'wrong-environment' ELSE 'local-disposable' END),
        'sample', n, 'case', c)::text END,
      CASE WHEN variant = 1 THEN 'fail' WHEN variant = 11 THEN NULL ELSE 'pass' END,
      CASE WHEN variant = 2 THEN 'v1' WHEN variant = 12 THEN NULL ELSE 'v2' END,
      CASE WHEN variant = 10 THEN 'run-current' WHEN variant = 13 THEN NULL ELSE 'run-history' END
    FROM unnest(ARRAY['case-alpha', 'case-beta', 'case-scarce', 'case-no-identity', 'case''quoted']) c
    CROSS JOIN generate_series(1, 95) n CROSS JOIN generate_series(0, 16) variant
    WHERE c <> 'case-scarce' OR n <= 8;
    ANALYZE ${table}`);
  const strict = compare({ ...common, strictOnly: true });
  const counts = Object.fromEntries(
    caseIds.map((id) => [id, strict.filter((row) => row.c === id).length]),
  );
  assert.deepEqual(counts, {
    "case-alpha": 60,
    "case-beta": 60,
    "case-scarce": 8,
    "case-no-identity": 0,
    "case'quoted": 60,
    "case-empty": 0,
  });
  assert.ok(strict.every((row) => caseIds.includes(row.c)));
  for (const strictOnly of [false, true]) {
    for (const perCase of [0, -2, 1, 2.9, 60, 120])
      compare({ ...common, strictOnly, perCase });
  }
  compare({ ...common, currentRunId: undefined });
  compare({ ...common, includeMeasurement: false });
  compare({ ...common, includeMeasurement: false, strictOnly: true });
  compare({ ...common, caseIds: ["case-alpha", "case-alpha", "case'quoted"] });
  compare({ ...common, caseIds: [] });
  // Crossing a timestamp tie cannot have a unique row identity under the old
  // contract. Identical complete projections make the deterministic equality
  // assertion valid without imposing a new tie breaker on production results.
  psql(`TRUNCATE ${table}; INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
    SELECT 'case-alpha', 42, '2026-01-01'::timestamptz, '{"contract":{"id":"contract-neutral"},"environment":{"class":"local-disposable"}}', 'pass', 'v2', 'run-history' FROM generate_series(1, 65)`);
  assert.equal(compare({ ...common, strictOnly: true }).length, 60);

  // A non-identical tie crossing a varying quota has no defined winner under
  // the old contract. Assert the admissible set and exact quota for both
  // queries instead of a selection the contract never promised.
  psql(`TRUNCATE ${table};
    INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
      SELECT 'case-tie', n, '2026-02-01'::timestamptz, '{"contract":{"id":"contract-neutral"},"environment":{"class":"local-disposable"}}', 'pass', 'v2', 'run-history'
      FROM generate_series(1, 5) n;
    INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID")
      SELECT 'case-tie', 100 + n, '2026-03-01'::timestamptz + n * interval '1 second', '{"contract":{"id":"contract-neutral"},"environment":{"class":"local-disposable"}}', 'pass', 'v2', 'run-history'
      FROM generate_series(1, 3) n;
    ANALYZE ${table}`);
  const tieIdentity = { "case-tie": identity };
  const newerValues = [101, 102, 103];
  for (const strictOnly of [false, true]) {
    for (const perCase of [1, 2, 4, 5, 8]) {
      const tieOptions = {
        caseIds: ["case-tie"],
        currentRunId: "run-current",
        includeMeasurement: true,
        identityByCase: tieIdentity,
        strictOnly,
        perCase,
      };
      for (const rows of [
        readRows(oldSql(tieOptions)),
        readRows(newSql({ ...tieOptions, branched: false })),
        readRows(newSql({ ...tieOptions, branched: true })),
      ]) {
        assert.equal(rows.length, perCase);
        const values = rows.map((row) => row.v);
        assert.equal(new Set(values).size, perCase);
        assert.ok(rows.every((row) => row.c === "case-tie"));
        assert.ok(
          values.every(
            (value) =>
              (value >= 1 && value <= 5) || newerValues.includes(value),
          ),
        );
        const expectedNewer = Math.min(newerValues.length, perCase);
        assert.deepEqual(
          values.filter((value) => newerValues.includes(value)).sort(),
          newerValues.slice(-expectedNewer),
        );
        assert.equal(
          values.filter((value) => value <= 5).length,
          perCase - expectedNewer,
        );
        const timestamps = rows.map((row) => Date.parse(row.t));
        assert.ok(timestamps.every(Number.isFinite));
        assert.deepEqual(
          timestamps,
          [...timestamps].sort((left, right) => right - left),
        );
      }
    }
  }
  console.log("PostgreSQL complete-row history equivalence checks passed");

  if (process.argv.includes("--perf")) {
    // Same row/field cardinality as the motivating baseline, with entirely
    // synthetic payloads. This is not a customer-data or byte-layout replay.
    psql(`TRUNCATE ${table}; INSERT INTO ${table} ("Case_ID", "Primary_Metric_Value", "Started_At", "Measurement_JSON", "Status", "Engine", "Run_ID", "Neutral_0")
      SELECT 'perf-' || (n % 8), n, '2026-01-01'::timestamptz + n * interval '1 second',
        jsonb_build_object('contract', jsonb_build_object('id', CASE WHEN n % 11 = 0 THEN 'wrong-contract' ELSE 'contract-neutral' END), 'environment', jsonb_build_object('class', 'local-disposable'), 'padding', repeat(md5(n::text), 8))::text,
        CASE WHEN n % 19 = 0 THEN 'fail' ELSE 'pass' END, CASE WHEN n % 23 = 0 THEN 'v1' ELSE 'v2' END,
        CASE WHEN n % 29 = 0 THEN 'run-current' ELSE 'run-history' END, repeat(md5(n::text), 8)
      FROM generate_series(1, 631872) n;
      CREATE INDEX ON ${table} ("Started_At"); ANALYZE ${table}`);
    const perfCases = Array.from({ length: 8 }, (_, index) => `perf-${index}`);
    const options = {
      ...common,
      caseIds: perfCases,
      identityByCase: Object.fromEntries(perfCases.map((id) => [id, identity])),
    };
    for (const indexMode of ["started-at-only", "case-started-at"]) {
      if (indexMode === "case-started-at")
        psql(
          `CREATE INDEX ON ${table} ("Case_ID", "Started_At" DESC); ANALYZE ${table}`,
        );
      for (const strictOnly of [false, true]) {
        compare({ ...options, strictOnly });
        const queries = {
          old: oldSql({ ...options, strictOnly }),
          new: newSql({ ...options, strictOnly, branched: true }),
        };
        const explain = (sql) =>
          jsonQuery(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${sql}`)[0];
        // One warmup each, then six interleaved samples with reversed order.
        for (const sql of Object.values(queries)) explain(sql);
        const samples = { old: [], new: [] };
        for (let repeat = 0; repeat < 6; repeat++) {
          for (const label of repeat % 2 ? ["new", "old"] : ["old", "new"])
            samples[label].push(explain(queries[label]));
        }
        const summary = Object.fromEntries(
          Object.entries(samples).map(([label, plans]) => [
            label,
            {
              executionMs: plans.map((plan) => plan["Execution Time"]),
              sharedHitBlocks: plans.map(
                (plan) => plan.Plan["Shared Hit Blocks"] ?? 0,
              ),
              sharedReadBlocks: plans.map(
                (plan) => plan.Plan["Shared Read Blocks"] ?? 0,
              ),
              tempReadBlocks: plans.map(
                (plan) => plan.Plan["Temp Read Blocks"] ?? 0,
              ),
              tempWrittenBlocks: plans.map(
                (plan) => plan.Plan["Temp Written Blocks"] ?? 0,
              ),
            },
          ]),
        );
        console.log(
          JSON.stringify({
            indexMode,
            strictOnly,
            rows: 631872,
            fields: 33,
            warmups: 1,
            repetitions: 6,
            summary,
            samples,
          }),
        );
      }
    }
  }
} finally {
  if (created) psql(`DROP SCHEMA "${schema}" CASCADE`);
}
