#!/usr/bin/env node
// Read-only evidence-key uniqueness check for the stress-test evidence base.
//
//   BASE_URL=https://staging.teable.ai TEABLE_TOKEN=... \
//     node scripts/stress/check-evidence-keys.mjs [--table tbl...] [--json]
//
// Exits 1 when any table has duplicate 证据键 or a row without a key. Never
// writes. The key generator and duplicate logic live in evidence-gate.mjs so
// the recorder and this check cannot drift apart. Table IDs come from
// evidence-schema.mjs; each has an EVIDENCE_<TABLE>_TABLE_ID override.
// --base-id / EVIDENCE_BASE_ID are reported as the audit's ownership metadata
// but never change the Teable table API path.

import process from "node:process";
import { classifyEvidenceKey, findDuplicateKeys } from "./evidence-gate.mjs";
import { resolveEvidenceSchema } from "./evidence-schema.mjs";

function parseArgs(argv) {
  const out = { tables: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") out.json = true;
    else if (arg === "--table") out.tables.push(argv[++i]);
    else if (arg.startsWith("--table="))
      out.tables.push(arg.slice("--table=".length));
    else if (arg === "--base-url") out.baseUrl = argv[++i];
    else if (arg === "--base-id") out.baseId = argv[++i];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args.baseUrl || process.env.BASE_URL || "").replace(
  /\/+$/,
  "",
);
const token = process.env.TEABLE_TOKEN || process.env.TOKEN || "";
const evidenceSchema = resolveEvidenceSchema({ baseId: args.baseId });
const DEFAULT_TABLES = evidenceSchema.tableIds;
if (!baseUrl || !token) {
  console.error("BASE_URL and TEABLE_TOKEN are required (read-only check).");
  process.exit(2);
}

async function request(path) {
  const res = await fetch(`${baseUrl}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function keyField(tableId) {
  const fields = await request(
    `/api/table/${encodeURIComponent(tableId)}/field`,
  );
  const field = (fields || []).find((item) => item.name === "证据键");
  return field?.id || null;
}

async function scan(tableId, fieldId) {
  const rows = [];
  const pageSize = 1000;
  for (let skip = 0; ; skip += pageSize) {
    const page = await request(
      `/api/table/${encodeURIComponent(tableId)}/record?take=${pageSize}&skip=${skip}`,
    );
    const records = page?.records || [];
    for (const record of records) {
      rows.push({ table: tableId, key: record.fields?.[fieldId] ?? null });
    }
    if (records.length < pageSize) break;
  }
  return rows;
}

const entries = args.tables.length
  ? args.tables.map((tableId) => [tableId, tableId])
  : Object.entries(DEFAULT_TABLES);
const result = {
  baseId: evidenceSchema.baseId,
  baseUrl,
  tables: {},
  duplicateCount: 0,
  missingCount: 0,
};
for (const [name, tableId] of entries) {
  const fieldId = await keyField(tableId);
  if (!fieldId) {
    result.tables[name] = { tableId, error: "no 证据键 field" };
    continue;
  }
  const rows = await scan(tableId, fieldId);
  const { duplicates, missing } = findDuplicateKeys(rows);
  for (const item of duplicates) item.kind = classifyEvidenceKey(item.key);
  result.tables[name] = {
    tableId,
    rows: rows.length,
    duplicates,
    missing: missing.length,
  };
  result.duplicateCount += duplicates.length;
  result.missingCount += missing.length;
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const [name, entry] of Object.entries(result.tables)) {
    if (entry.error) {
      console.log(`${name} ${entry.tableId}: ERROR ${entry.error}`);
      continue;
    }
    console.log(
      `${name} ${entry.tableId}: rows=${entry.rows} duplicates=${entry.duplicates.length} missing-key=${entry.missing}`,
    );
    for (const duplicate of entry.duplicates) {
      console.log(
        `  duplicate (${duplicate.kind}, ${duplicate.count}x): ${duplicate.key}`,
      );
    }
  }
  console.log(
    `total duplicates=${result.duplicateCount} missing-key=${result.missingCount}`,
  );
}

process.exit(result.duplicateCount > 0 || result.missingCount > 0 ? 1 : 0);
