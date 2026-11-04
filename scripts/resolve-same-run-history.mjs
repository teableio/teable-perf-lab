// Recent V2 measurements for the same-run panel.
//
// The comparison itself is pure (`same-run-comparison-model.mjs`). This file
// is the Teable read that feeds it: the last `SAME_RUN_HISTORY_POINTS`
// passing V2 values per case this run measured, excluding this run so the
// quantile is not calibrated on the point under test.
//
// Batched because the SQL endpoint caps a response at 50k characters. Eight
// cases × 60 points stays under that; a full run is a few dozen small
// queries rather than one that the API silently truncates.
//
// Both reads use bounded per-case lookups over scalar identity columns. Deploy
// only after the scalar writer, historical backfill and ordered indexes are ready.
// Historical JSON remains evidence, not a filter or a projected comparison input.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./env.mjs";
import {
  SAME_RUN_HISTORY_POINTS,
  buildSameRunComparison,
  comparableHistoryByCaseFromRows,
} from "./same-run-comparison-model.mjs";
import { loadTeableFields } from "./teable-field-read.mjs";
import {
  extractMeasurementIdentity,
  resolvePerformanceTrackIdentityColumns,
} from "./performance-track-identity.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE = "tblwPqrcchUzvyEOqLo";
const CASE_BATCH_SIZE = 8;

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;
const sqlIdentifier = (value) => `"${String(value).replaceAll('"', '""')}"`;

export const buildSameRunHistorySql = ({
  caseIds,
  currentRunId,
  perCase = SAME_RUN_HISTORY_POINTS,
  baseId = DEFAULT_BASE_ID,
  tableId = DEFAULT_TABLE,
  identityColumns = { contractId: "Contract_ID", environmentClass: "Environment_Class" },
  identityByCase = {},
  strictOnly = false,
} = {}) => {
  const ids = [...new Set((caseIds ?? []).filter(Boolean))];
  if (ids.length === 0) return undefined;
  const runClause = currentRunId ? ` AND "Run_ID" <> ${sqlLiteral(currentRunId)}` : "";
  const contract = sqlIdentifier(identityColumns.contractId);
  const environment = sqlIdentifier(identityColumns.environmentClass);
  const targets = ids.flatMap((caseId) => {
    const identity = identityByCase[caseId];
    if (strictOnly && (!identity?.contractId || !identity?.environmentClass)) return [];
    return [strictOnly
      ? `(${sqlLiteral(caseId)}, ${sqlLiteral(identity.contractId)}, ${sqlLiteral(identity.environmentClass)})`
      : `(${sqlLiteral(caseId)})`];
  });
  if (targets.length === 0) return undefined;
  const columns = strictOnly ? "c, k, h" : "c";
  const identityClause = strictOnly
    ? ` AND ${contract} = target.k AND ${environment} = target.h`
    : "";
  // Keep the small target relation parameterized even for one case. Inlining
  // its constants can make LIMIT choose a global time-index scan that never
  // finds a missing identity. OFFSET 0 fences targets only, not history rows.
  // The public SQL parser accepts this form but not CTE AS MATERIALIZED.
  return `WITH target AS (SELECT * FROM (VALUES ${targets.join(", ")}) ` +
    `AS wanted(${columns}) OFFSET 0) ` +
    `SELECT history.c, history.v, history.t, history.k, history.h FROM target ` +
    `CROSS JOIN LATERAL (SELECT "Case_ID" AS c, "Primary_Metric_Value" AS v, ` +
    `"Started_At" AS t, ${contract} AS k, ${environment} AS h ` +
    `FROM ${sqlIdentifier(baseId)}.${sqlIdentifier(tableId)} ` +
    `WHERE "Status" = 'pass' AND "Engine" = 'v2' AND "Primary_Metric_Value" > 0 ` +
    `AND "Case_ID" = target.c${runClause}${identityClause} ` +
    `ORDER BY "Started_At" DESC LIMIT ${Math.max(0, Math.floor(Number(perCase)))}) history`;
};

const sqlQuery = async ({ endpoint, token, baseId, sql }) => {
  if (token) {
    const res = await fetch(
      `${endpoint.replace(/\/+$/, "")}/api/base/${baseId}/sql-query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql }),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Teable SQL failed: ${res.status} ${text}`);
    }
    const data = JSON.parse(text);
    if (data?.success === false) {
      throw new Error(data.error ?? "unknown SQL error");
    }
    return data?.rows ?? [];
  }

  const { stdout } = await execFileAsync(
    "teable",
    ["sql-query", "--base-id", baseId, "--sql", sql],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const data = JSON.parse(stdout);
  if (data?.success === false) {
    throw new Error(data.error ?? "unknown SQL error");
  }
  return data?.rows ?? [];
};

export const rowsFromSqlResult = (rows = []) =>
  rows.map((row) => ({
    caseId: row.c ?? row.Case_ID,
    value: row.v ?? row.Primary_Metric_Value,
    startedAt: row.t ?? row.Started_At,
    contractId: row.k ?? row.Contract_ID ?? null,
    environmentClass: row.h ?? row.Environment_Class ?? null,
  }));

const batchesOf = (items, size) => {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

export const loadSameRunHistory = async ({
  caseIds,
  currentRunId,
  identityByCase = {},
} = {}) => {
  const ids = [...new Set((caseIds ?? []).filter(Boolean))];
  if (ids.length === 0) {
    return { valuesByCase: {}, compatibilityByCase: {} };
  }

  const token = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");
  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const baseId = env("TEABLE_PERF_LAB_BASE_ID", DEFAULT_BASE_ID);
  const tableId = env("TEABLE_PERF_LAB_TABLE_ID", DEFAULT_TABLE);
  const fields = await loadTeableFields({ endpoint, token, baseId, tableId });
  const identityColumns = resolvePerformanceTrackIdentityColumns(fields);
  const rows = [];
  const strictRows = [];

  for (const batch of batchesOf(ids, CASE_BATCH_SIZE)) {
    const sql = buildSameRunHistorySql({
      caseIds: batch,
      currentRunId,
      baseId,
      tableId,
      identityColumns,
    });
    const page = await sqlQuery({ endpoint, token, baseId, sql });
    rows.push(...rowsFromSqlResult(page));
    const strictSql = buildSameRunHistorySql({
      caseIds: batch,
      currentRunId,
      baseId,
      tableId,
      identityColumns,
      identityByCase,
      strictOnly: true,
    });
    if (strictSql) {
      const strictPage = await sqlQuery({
        endpoint,
        token,
        baseId,
        sql: strictSql,
      });
      strictRows.push(...rowsFromSqlResult(strictPage));
    }
  }

  return comparableHistoryByCaseFromRows(rows, {
    identityByCase,
    strictRows,
  });
};

export const resolveSameRunComparison = async ({
  payloads = [],
  currentRunId,
} = {}) => {
  const currentV2 = payloads.filter(
    (payload) => payload.engine === "v2" && payload.result === "pass",
  );
  const caseIds = [
    ...new Set(currentV2.map((payload) => payload.caseId).filter(Boolean)),
  ];
  const identityByCase = Object.fromEntries(
    currentV2
      .filter((payload) => payload.measurement)
      .map((payload) => [
        payload.caseId,
        extractMeasurementIdentity(payload.measurement),
      ]),
  );
  const history = await loadSameRunHistory({
    caseIds,
    currentRunId,
    identityByCase,
  });
  return buildSameRunComparison({
    payloads,
    historyByCase: history.valuesByCase,
    historyCompatibilityByCase: history.compatibilityByCase,
  });
};
