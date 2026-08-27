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

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { env } from "./env.mjs";
import {
  SAME_RUN_HISTORY_POINTS,
  historyByCaseFromRows,
} from "./same-run-comparison-model.mjs";

const execFileAsync = promisify(execFile);

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE = "tblwPqrcchUzvyEOqLo";
const CASE_BATCH_SIZE = 8;

const sqlLiteral = (value) => `'${String(value).replaceAll("'", "''")}'`;

export const buildSameRunHistorySql = ({
  caseIds,
  currentRunId,
  perCase = SAME_RUN_HISTORY_POINTS,
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
  return (
    `SELECT c, v, t FROM (` +
    `SELECT "Case_ID" AS c, "Primary_Metric_Value" AS v, "Started_At" AS t, ` +
    `row_number() OVER (PARTITION BY "Case_ID" ORDER BY "Started_At" DESC) AS rn ` +
    `FROM "${baseId}"."${tableId}" ` +
    `WHERE "Status" = 'pass' AND "Engine" = 'v2' ` +
    `AND "Primary_Metric_Value" > 0 ` +
    `AND "Case_ID" IN (${inList})${runClause}` +
    `) x WHERE rn <= ${Number(perCase)}`
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
    caseId: row.c ?? row.Case_ID,
    value: row.v ?? row.Primary_Metric_Value,
    startedAt: row.t ?? row.Started_At,
  }));

const batchesOf = (items, size) => {
  const batches = [];
  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }
  return batches;
};

export const loadSameRunHistory = async ({ caseIds, currentRunId } = {}) => {
  const ids = [...new Set((caseIds ?? []).filter(Boolean))];
  if (ids.length === 0) {
    return {};
  }

  const token = env("TEABLE_PERF_LAB_TOKEN") || env("TEABLE_TOKEN");
  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const baseId = env("TEABLE_PERF_LAB_BASE_ID", DEFAULT_BASE_ID);
  const rows = [];

  for (const batch of batchesOf(ids, CASE_BATCH_SIZE)) {
    const sql = buildSameRunHistorySql({
      caseIds: batch,
      currentRunId,
      baseId,
    });
    const page = await sqlQuery({ endpoint, token, baseId, sql });
    rows.push(...rowsFromSqlResult(page));
  }

  return historyByCaseFromRows(rows);
};
