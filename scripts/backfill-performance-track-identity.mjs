import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFileAtomically } from "../framework/atomic-file.js";
import { env, requiredEnv } from "./env.mjs";
import {
  extractMeasurementIdentity,
  resolvePerformanceTrackIdentityColumns,
} from "./performance-track-identity.mjs";

const CATEGORIES = ["already-matching", "valid-missing", "partial-compatible", "conflict", "invalid-json", "missing-or-incomplete-identity"];
const emptyCounts = () => Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
const empty = (value) => value === null || value === undefined || value === "";
const identifier = (value) => `"${value.replaceAll('"', '""')}"`;
const positive = (value, name, maximum = Number.MAX_SAFE_INTEGER) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
};

// Historical strings are decoded only here, never in the live history readers.
export const classifyPerformanceTrackIdentity = ({ measurement, contractId, environmentClass }) => {
  let decoded = measurement;
  if (typeof decoded === "string" && decoded !== "") {
    try { decoded = JSON.parse(decoded); }
    catch {
      return { category: empty(contractId) && empty(environmentClass) ? "invalid-json" : "conflict" };
    }
  }
  const identity = extractMeasurementIdentity(decoded);
  for (const [key, current] of Object.entries({ contractId, environmentClass })) {
    if (!empty(current) && (typeof current !== "string" || current !== identity[key])) {
      return { category: "conflict" };
    }
  }
  if (identity.contractId === null || identity.environmentClass === null) return { category: "missing-or-incomplete-identity" };
  const missing = [contractId, environmentClass].filter(empty).length;
  return {
    category: missing === 0 ? "already-matching" : missing === 2 ? "valid-missing" : "partial-compatible",
    identity,
  };
};

const normalizeEndpoint = (endpoint) => {
  const url = new URL(endpoint);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error("Endpoint must be an HTTP(S) origin without credentials, query, or path");
  }
  return url.origin;
};

export const createIdentityBackfillHttpAdapter = ({ endpoint, token, baseId, tableId, maxResponseBytes = 1024 * 1024 }) => {
  endpoint = normalizeEndpoint(endpoint);
  if (!token) throw new Error("TEABLE_PERF_LAB_TOKEN is required");
  const request = async (path, { method = "GET", body, byteLimit = maxResponseBytes } = {}) => {
    const response = await fetch(`${endpoint}/api${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    // Do not print response bodies: error responses can contain source data.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Teable ${method} failed (${response.status}); outcome of a PATCH may be unknown; resume to reclassify`);
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > Math.min(maxResponseBytes, byteLimit)) {
        await response.body.cancel().catch(() => {});
        throw new Error("Response byte bound exceeded; cursor not advanced for this page");
      }
      chunks.push(chunk);
    }
    let data;
    try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
    catch { throw new Error("Invalid Teable JSON response; cursor not advanced for this page"); }
    if (data?.success === false) throw new Error("Teable request rejected; cursor not advanced for this page");
    return { data, bytes };
  };
  const sql = async (query) => {
    const { data } = await request(`/base/${encodeURIComponent(baseId)}/sql-query`, { method: "POST", body: { sql: query } });
    if (!Array.isArray(data?.rows)) throw new Error("SQL response has no rows array");
    return data.rows;
  };
  let metadata;
  return {
    async loadMetadata() {
      const [{ data: table }, { data: fields }] = await Promise.all([
        request(`/base/${encodeURIComponent(baseId)}/table/${encodeURIComponent(tableId)}`),
        request(`/table/${encodeURIComponent(tableId)}/field`),
      ]);
      resolvePerformanceTrackIdentityColumns(fields);
      const selected = ["Measurement JSON", "Contract ID", "Environment Class"].map((name) => {
        const matches = fields.filter((field) => field.name === name);
        if (matches.length !== 1) throw new Error(`Missing or ambiguous ${name} metadata`);
        const field = matches[0];
        if (!field.id || !field.dbFieldName || !["singleLineText", "longText"].includes(field.type) || field.isComputed || field.isLookup) {
          throw new Error(`Invalid ${name} metadata`);
        }
        return { id: field.id, name: field.name, type: field.type, dbFieldName: field.dbFieldName };
      });
      // The real GET table response carries id/dbTableName but no baseId. The
      // project is therefore taken from the explicit request path, and any
      // baseId that does appear must agree with it.
      if (table.id !== tableId || typeof table.dbTableName !== "string" || !table.dbTableName.trim() || (table.baseId !== undefined && table.baseId !== baseId)) {
        throw new Error("Table metadata does not match target project/table");
      }
      const parts = table.dbTableName.split(".");
      if (parts.some((part) => !part)) throw new Error("Invalid dbTableName metadata");
      // Same convention as the perf runners: a qualified name must name this
      // project; an unqualified physical table name lives in the project schema.
      if (parts.length > 1 && (parts.length !== 2 || parts[0] !== baseId)) throw new Error("dbTableName does not belong to the target project");
      const sqlTable = (parts.length === 1 ? [baseId, parts[0]] : parts).map(identifier).join(".");
      metadata = { tableId, dbTableName: table.dbTableName, sqlTable, fields: selected };
      return metadata;
    },
    async highWater() {
      const rows = await sql(`SELECT COALESCE(MAX("__auto_number"), 0) AS h FROM ${metadata.sqlTable}`);
      const value = Number(rows[0]?.h);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid __auto_number high-water mark");
      return value;
    },
    async scan({ cursor, highWater, limit }) {
      return sql(`SELECT "__id" AS id, "__auto_number" AS n FROM ${metadata.sqlTable} WHERE "__auto_number" > ${cursor} AND "__auto_number" <= ${highWater} ORDER BY "__auto_number" ASC LIMIT ${limit}`);
    },
    async readRecord(id, byteLimit) {
      const query = new URLSearchParams({ fieldKeyType: "id" });
      for (const field of metadata.fields) query.append("projection", field.id);
      const { data, bytes } = await request(`/table/${encodeURIComponent(tableId)}/record/${encodeURIComponent(id)}?${query}`, { byteLimit });
      if (data.id !== id || !data.fields || typeof data.fields !== 'object') throw new Error("Record response does not match scan");
      const [source, contract, environment] = metadata.fields;
      return { bytes, values: { measurement: data.fields[source.id], contractId: data.fields[contract.id], environmentClass: data.fields[environment.id] } };
    },
    async patchIdentity(id, identity) {
      const [, contract, environment] = metadata.fields;
      // No retries and no source/business fields. This is NOT compare-and-swap.
      await request(`/table/${encodeURIComponent(tableId)}/record/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: { fieldKeyType: "id", typecast: false, record: { fields: { [contract.id]: identity.contractId, [environment.id]: identity.environmentClass } } },
      });
    },
  };
};

const fingerprint = (value) => JSON.stringify(value);
const readCheckpoint = async (path) => {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw new Error("Cannot read checkpoint"); }
};

export const runIdentityBackfill = async ({
  endpoint, baseId, tableId, checkpointPath, mode = "plan", resume = false,
  acknowledgeWritersPausedAndDrained = false, fenceProvenance = "",
  pageSize = 25, maxRows = 1000, maxBytes = 16 * 1024 * 1024, adapter,
}) => {
  endpoint = normalizeEndpoint(endpoint);
  if (!baseId || !tableId || !checkpointPath || !adapter || !["plan", "apply"].includes(mode)) throw new Error("Missing or invalid backfill configuration");
  positive(pageSize, "page-size", 100);
  positive(maxRows, "max-rows");
  positive(maxBytes, "max-bytes");
  if (mode === "apply" && (!acknowledgeWritersPausedAndDrained || !fenceProvenance.trim())) {
    throw new Error("Apply requires acknowledgement that ALL writers are paused and drained, plus external fence provenance; a flag is not a fence");
  }
  const metadata = await adapter.loadMetadata();
  const binding = { endpoint, baseId, tableId, metadata, mode };
  let checkpoint = await readCheckpoint(checkpointPath);
  if (checkpoint && !resume) throw new Error("Checkpoint exists; use --resume or a different checkpoint path");
  if (!checkpoint && resume) throw new Error("Resume checkpoint does not exist");
  if (checkpoint) {
    if (checkpoint.version !== 1 || fingerprint(checkpoint.binding) !== fingerprint(binding)) throw new Error("Checkpoint target/schema/mode mismatch");
    if (!Number.isSafeInteger(checkpoint.cursor) || !Number.isSafeInteger(checkpoint.highWater) || checkpoint.cursor < 0 || checkpoint.highWater < checkpoint.cursor ||
        !CATEGORIES.every((category) => Number.isSafeInteger(checkpoint.counts?.[category]) && checkpoint.counts[category] >= 0) ||
        !Number.isSafeInteger(checkpoint.updated) || checkpoint.updated < 0) throw new Error("Invalid checkpoint state");
  } else {
    checkpoint = { version: 1, binding, cursor: 0, highWater: await adapter.highWater(), counts: emptyCounts(), updated: 0, complete: false };
    await writeFileAtomically(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  }
  const save = async () => writeFileAtomically(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
  let analyzed = 0;
  let bytes = 0;
  const assertFence = async () => {
    if (fingerprint(await adapter.loadMetadata()) !== fingerprint(metadata)) throw new Error("Schema changed; stop and re-establish writer fence");
    if (mode === "apply" && await adapter.highWater() !== checkpoint.highWater) throw new Error("Writer fence violation: high-water mark changed");
  };
  while (!checkpoint.complete && analyzed < maxRows) {
    await assertFence();
    const rows = await adapter.scan({ cursor: checkpoint.cursor, highWater: checkpoint.highWater, limit: Math.min(pageSize, maxRows - analyzed) });
    if (!Array.isArray(rows) || rows.length > Math.min(pageSize, maxRows - analyzed)) throw new Error("Invalid bounded scan response");
    if (rows.length === 0) { checkpoint.complete = true; await save(); break; }
    let cursor = checkpoint.cursor;
    const ids = new Set();
    for (const row of rows) {
      const n = Number(row.n);
      if (typeof row.id !== "string" || !row.id || ids.has(row.id) || !Number.isSafeInteger(n) || n <= cursor || n > checkpoint.highWater) throw new Error("Invalid stable scan cursor");
      ids.add(row.id);
      cursor = n;
    }
    const counts = emptyCounts();
    let updated = 0;
    for (const row of rows) {
      if (bytes >= maxBytes) return { ...checkpoint, stopped: "byte-bound", analyzed, bytes };
      const snapshot = await adapter.readRecord(row.id, maxBytes - bytes);
      bytes += snapshot.bytes;
      const result = classifyPerformanceTrackIdentity(snapshot.values);
      counts[result.category]++;
      if (result.category === "conflict") {
        const error = new Error("Identity conflict; no further progress and no conflicting scalar overwritten; page cursor unchanged");
        error.category = "conflict";
        error.counts = { ...counts };
        throw error;
      }
      if (mode === "apply" && ["valid-missing", "partial-compatible"].includes(result.category)) {
        await assertFence();
        if (bytes >= maxBytes) return { ...checkpoint, stopped: "byte-bound", analyzed, bytes };
        const fresh = await adapter.readRecord(row.id, maxBytes - bytes);
        bytes += fresh.bytes;
        if (fingerprint(fresh.values) !== fingerprint(snapshot.values)) throw new Error("Writer fence violation: source/targets changed before PATCH; page cursor unchanged");
        await adapter.patchIdentity(row.id, result.identity);
        updated++;
      }
    }
    // A partially acknowledged page is intentionally replayed after any failure.
    // Reclassification makes an unknown-outcome PATCH idempotent under the fence.
    for (const category of CATEGORIES) checkpoint.counts[category] += counts[category];
    checkpoint.updated += updated;
    checkpoint.cursor = cursor;
    checkpoint.complete = cursor === checkpoint.highWater;
    await save();
    analyzed += rows.length;
  }
  return { ...checkpoint, stopped: checkpoint.complete ? "complete" : "row-bound", analyzed, bytes };
};

export const IDENTITY_BACKFILL_HELP = `Usage: node scripts/backfill-performance-track-identity.mjs --checkpoint PATH [--resume] [--apply --writers-paused-and-drained --fence-provenance TEXT] [--page-size N] [--max-rows N] [--max-bytes N]
Default: plan only. Configuration: TEABLE_ENDPOINT, TEABLE_PERF_LAB_BASE_ID,
TEABLE_PERF_LAB_TRACK_TABLE_ID (or TEABLE_PERF_LAB_TABLE_ID), TEABLE_PERF_LAB_TOKEN.
Only SELECT is sent to the SQL API. Actual table/field IDs, database names and
the physical table are read from metadata; an unqualified dbTableName is resolved
in the target project, and a qualified one must name that project. Identity is
copied from historical Measurement JSON, never regenerated. Invalid or incomplete
data is counted without invented values or payload logging. Conflicts stop the run.
Any populated scalar unsupported by the source is a conflict, including invalid
JSON or missing source identity. A matching partial scalar may remain incomplete
and strict-ineligible; the migration never invents its missing source component.
Apply PATCHes only the two scalar identity fields.

APPLY REQUIRES A REAL EXTERNAL FENCE: pause and drain ALL report jobs, full-row
saves, and every other writer to the table before starting; keep them fenced until
reconciliation finishes. --writers-paused-and-drained is acknowledgement, NOT a
fence. --fence-provenance must identify the external maintenance/fence evidence.
Concurrent migration is unsupported. GET/PATCH is NOT CAS. Narrow rereads and
high-water checks detect only obvious changes, not all concurrent writes.

Checkpoints bind endpoint/project/table/source+target field metadata/mode and the
initial __auto_number high-water mark. A plan checkpoint cannot be applied: use a
new apply checkpoint after establishing the fence. Resume with the SAME mode and
target, and renew the external fence acknowledgement/provenance on EVERY apply.
No token or Measurement JSON is stored. Page cursor advances only after all writes
are acknowledged. On unknown PATCH outcome resume to reread/reclassify the page;
never blindly retry a write. Invalid data may advance only as reported categories.
Defaults: page-size 25 (max 100), max-rows 1000 per invocation, max-bytes 16777216
for record reads per invocation; each HTTP response is capped at 1 MiB. Exceeding
an HTTP bound fails without advancing that page; reduce page-size or investigate
oversized source records. Use --resume for the next bounded invocation.
`;

const cli = async () => {
  const flags = new Set(["--apply", "--resume", "--writers-paused-and-drained"]);
  const values = new Set(["--checkpoint", "--fence-provenance", "--page-size", "--max-rows", "--max-bytes"]);
  const args = process.argv.slice(2);
  if (args.includes("--help")) { process.stdout.write(IDENTITY_BACKFILL_HELP); return; }
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (options[key] !== undefined) throw new Error("Duplicate CLI option");
    if (flags.has(key)) options[key] = true;
    else if (values.has(key) && args[index + 1] && !args[index + 1].startsWith("--")) options[key] = args[++index];
    else throw new Error("Unknown option or missing option value; use --help");
  }
  const endpoint = env("TEABLE_ENDPOINT", "https://app.teable.ai");
  const baseId = env("TEABLE_PERF_LAB_BASE_ID", "bselS3I2MeVI6RJhS4g");
  const tableId = env("TEABLE_PERF_LAB_TRACK_TABLE_ID") || env("TEABLE_PERF_LAB_TABLE_ID", "tblwPqrcchUzvyEOqLo");
  if (!options["--checkpoint"]) throw new Error("--checkpoint is required");
  const adapter = createIdentityBackfillHttpAdapter({ endpoint, baseId, tableId, token: requiredEnv("TEABLE_PERF_LAB_TOKEN") });
  const result = await runIdentityBackfill({ endpoint, baseId, tableId, adapter, checkpointPath: resolve(options["--checkpoint"]),
    mode: options["--apply"] ? "apply" : "plan", resume: !!options["--resume"],
    acknowledgeWritersPausedAndDrained: !!options["--writers-paused-and-drained"], fenceProvenance: options["--fence-provenance"] ?? "",
    ...Object.fromEntries([["--page-size", "pageSize"], ["--max-rows", "maxRows"], ["--max-bytes", "maxBytes"]].filter(([flag]) => options[flag] !== undefined).map(([flag, key]) => [key, Number(options[flag])])),
  });
  // Report bounded aggregate counts, never record IDs or historical payloads.
  process.stdout.write(`${JSON.stringify({ mode: result.binding.mode, cursor: result.cursor, highWater: result.highWater, counts: result.counts, updated: result.updated, complete: result.complete, stopped: result.stopped, analyzed: result.analyzed, bytes: result.bytes })}\n`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  cli().catch((error) => {
    // Do not echo unexpected fetch/filesystem errors containing credentials or payloads.
    process.stderr.write(`${error.category === "conflict" ? `conflict ${JSON.stringify(error.counts)}: ` : ""}${error instanceof TypeError ? "Transport/configuration failure; page cursor unchanged" : error.message}\n`);
    process.exitCode = 1;
  });
}
