// Recent V1/V2 pairings for the engine panel.
//
// The comparison itself is pure (`engine-comparison-model.mjs`). This file is
// the Teable read that feeds it: one SQL query for the cases that already
// cleared the 1.2x / 50ms floors, then pair-by-run so tonight can be judged
// against each case's own recent median rather than against 1.0.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./env.mjs";
import {
  ENGINE_HISTORY_LOOKBACK,
  pairEngineHistoryRows,
} from "./engine-comparison-model.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE = "tblwPqrcchUzvyEOqLo";

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const buildEnginePairHistorySql = ({
  caseIds,
  currentRunId,
  baseId = DEFAULT_BASE_ID,
  tableId = DEFAULT_TABLE,
} = {}) => {
  const ids = [...new Set((caseIds ?? []).filter(Boolean))];
  if (ids.length === 0) {
    return undefined;
  }
  const inList = ids.map(sqlLiteral).join(", ");
  const runClause = currentRunId
    ? ` AND "Run_ID" <> ${sqlLiteral(currentRunId)}`
    : "";
  // Two engines per pair, `ENGINE_HISTORY_LOOKBACK` pairs, plus slack for
  // unpaired rows. The response cap is 50k; this stays well under it.
  const limit = Math.min(ids.length * ENGINE_HISTORY_LOOKBACK * 2 + 40, 800);
  return (
    `SELECT "Case_ID", "Engine", "Run_ID", "Primary_Metric_Value", "Started_At" ` +
    `FROM "${baseId}"."${tableId}" ` +
    `WHERE "Status" = 'pass' AND "Engine" IN ('v1', 'v2') ` +
    `AND "Case_ID" IN (${inList})${runClause} ` +
    `ORDER BY "Started_At" DESC LIMIT ${limit}`
  );
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
    caseId: row.Case_ID,
    engine: row.Engine,
    runId: row.Run_ID,
    value: row.Primary_Metric_Value,
    startedAt: row.Started_At,
  }));

export const loadEnginePairHistory = async ({
  caseIds,
  currentRunId,
} = {}) => {
  const sql = buildEnginePairHistorySql({ caseIds, currentRunId });
  if (!sql) {
    return {};
  }

  const token = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");
  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const baseId = env("TEABLE_PERF_LAB_BASE_ID", DEFAULT_BASE_ID);
  const rows = await sqlQuery({ endpoint, token, baseId, sql });
  return pairEngineHistoryRows(rowsFromSqlResult(rows), { currentRunId });
};
