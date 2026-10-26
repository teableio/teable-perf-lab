#!/usr/bin/env node
// Create a realistic business dataset and seed it through the Teable API.
// Domains: crm (default), ecommerce, project, hr. Volume is adjustable.
//
// Usage:
//   BASE_URL=https://staging.example.com TEABLE_TOKEN=... TEABLE_BASE_ID=bse... \
//     node stress-tests/tools/business-data.mjs --domain crm \
//       --customers 2000 --orders-per-customer 8 --items-per-order 3 --products 200
//
// API seeding is for small/medium volumes. For 1M+ rows use snapshot restore or direct DB seeding.

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import process from 'node:process';
import { buildBusinessProfile, logicalContext } from './business-profile.mjs';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const baseUrl = (args['base-url'] || process.env.BASE_URL || '').replace(/\/+$/, '');
const token = args.token || process.env.TEABLE_TOKEN || process.env.TOKEN || '';
const baseId = args['base-id'] || process.env.TEABLE_BASE_ID || '';
const env = args.env || process.env.STRESS_ENV || 'staging';
const batchSize = Math.max(1, Number(args['batch-size'] || 200));
const prefix = args.prefix || 'biz';
const outDir = resolve(args['out-dir'] || 'stress-tests/out');
const dryRun = Boolean(args['dry-run']);
const planOnly = Boolean(args.plan);
const allowLarge = Boolean(args['allow-large']);
const computed = args['no-computed'] ? false : true;
const maxRows = Number(args['max-rows'] || 250000);

function log(message) {
  process.stdout.write(`[business] ${message}\n`);
}

function fail(message) {
  console.error(`[business] ERROR: ${message}`);
  process.exit(1);
}

if (!dryRun && !planOnly) {
  if (!baseUrl || !token || !baseId) {
    fail('BASE_URL, TEABLE_TOKEN and TEABLE_BASE_ID are required (or use --plan / --dry-run).');
  }
}

let profile;
try {
  profile = await buildBusinessProfile(args);
} catch (error) {
  fail(error.message);
}

const { totalRows, counts } = profile;

if (!planOnly && !dryRun && totalRows > maxRows && !allowLarge) {
  log(`total rows ${totalRows} exceeds --max-rows ${maxRows}; pass --allow-large to override.`);
  log('Use snapshot/direct DB seeding for large volumes; API seeding is not linear.');
  process.exit(2);
}

function printPlan() {
  log(`domain: ${profile.domain} — ${profile.description}`);
  log(`base: ${baseId || '(missing)'}  url: ${baseUrl || '(missing)'}`);
  log(`total rows: ${totalRows} (max ${maxRows})`);
  log(`batch size: ${batchSize}`);
  log(`computed fields: ${computed ? 'yes' : 'no'}`);
  for (const table of profile.tables) {
    log(`${table.key}: ${table.count} rows, ${table.fields.length} fields`);
  }
  for (const workload of profile.workloads) {
    log(`workload: ${workload.table}.${workload.field} — ${workload.description}`);
  }
}

log(`business dataset ${profile.domain}: ${totalRows} rows`);
for (const table of profile.tables) log(`  ${table.key}: ${table.count}`);
if (planOnly) {
  printPlan();
  process.exit(0);
}
if (dryRun) {
  printPlan();
  const context = logicalContext(profile);
  for (const table of profile.tables) {
    if (table.count === 0) continue;
    log(`sample ${table.key}: ${JSON.stringify(table.record(0, context))}`);
  }
  process.exit(0);
}

async function request(method, path, body) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (res.ok) return text ? JSON.parse(text) : null;
      lastError = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((done) => setTimeout(done, 500 * attempt));
        continue;
      }
      throw lastError;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((done) => setTimeout(done, 500 * attempt));
    }
  }
  throw lastError;
}

function referenceError(tableKey, index) {
  return new Error(`Invalid reference ${tableKey}:${index}; earlier table is missing that record`);
}

const tableStates = new Map();
const idsByTable = new Map();

function apiField(field, tableKey) {
  if (field.type === 'formula') return null;
  if (field.type === 'link') {
    const target = tableStates.get(field.target);
    if (!target) throw new Error(`Link ${tableKey}.${field.name} targets an unknown table`);
    return {
      name: field.name,
      type: 'link',
      options: {
        relationship: field.many ? 'manyMany' : 'manyOne',
        foreignTableId: target.id,
        lookupFieldId: target.fields[0]?.id,
        isOneWay: false,
      },
    };
  }
  if (field.options) {
    return { name: field.name, type: field.type, options: field.options };
  }
  return { name: field.name, type: field.type };
}

async function createTable(name, fields) {
  log(`creating table ${name} (${fields.length} fields)`);
  const table = await request('POST', `/api/base/${encodeURIComponent(baseId)}/table/`, {
    name,
    fields,
  });
  log(`table ${name}: ${table.id}`);
  return table;
}

function resolveExpression(expression, fieldMap) {
  return expression.replace(/\{([^}]+)\}/g, (match, name) => {
    const field = fieldMap.get(name);
    if (!field) throw new Error(`Unknown formula reference ${name}`);
    return `{${field.id}}`;
  });
}

function resolveValue(value) {
  if (Array.isArray(value)) return value.map(resolveValue);
  if (value && typeof value === 'object' && typeof value.id === 'string' && value.id.includes(':')) {
    const [tableKey, rawIndex] = value.id.split(':');
    const index = Number(rawIndex);
    const ids = idsByTable.get(tableKey);
    if (!ids || !Number.isInteger(index) || !ids[index]) throw referenceError(tableKey, rawIndex);
    return { id: ids[index] };
  }
  return value;
}

function resolveFields(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) out[key] = resolveValue(value);
  return out;
}

function tableIdList(tableKey, count) {
  const ids = idsByTable.get(tableKey) || [];
  return ids.slice(0, Math.min(count, ids.length));
}

await mkdir(outDir, { recursive: true });

for (const tableProfile of profile.tables) {
  const plainFields = tableProfile.fields
    .filter((field) => field.type !== 'formula')
    .map((field) => apiField(field, tableProfile.key));
  const created = await createTable(`${prefix}_${tableProfile.name}`, plainFields);
  const fieldMap = new Map((created.fields || []).map((field) => [field.name, field]));
  let computedOk = true;
  if (computed) {
    for (const field of tableProfile.fields.filter((item) => item.type === 'formula')) {
      try {
        const formula = await request('POST', `/api/table/${encodeURIComponent(created.id)}/field`, {
          name: field.name,
          type: 'formula',
          options: { expression: resolveExpression(field.expression, fieldMap), timeZone: 'UTC' },
        });
        created.fields.push(formula);
        fieldMap.set(formula.name, formula);
      } catch (error) {
        computedOk = false;
        log(`WARN formula ${tableProfile.key}.${field.name} failed: ${String(error.message).slice(0, 200)}`);
      }
    }
  }
  tableStates.set(tableProfile.key, { ...created, fields: created.fields || [], computedOk, count: tableProfile.count });
}

const context = logicalContext(profile);
const computedNames = new Map();
for (const table of profile.tables) {
  computedNames.set(table.key, new Set(table.fields.filter((field) => field.type === 'formula').map((field) => field.name)));
}

const hashes = new Map();
const startedAt = Date.now();
let computedOk = true;

for (const table of profile.tables) {
  const state = tableStates.get(table.key);
  computedOk = computedOk && state.computedOk;
  const hash = createHash('sha256');
  hashes.set(table.key, hash);
  const ids = [];
  const formulaNames = computedNames.get(table.key);
  log(`seeding ${table.key} (${table.count})`);

  for (let offset = 0; offset < table.count; offset += batchSize) {
    const count = Math.min(batchSize, table.count - offset);
    const logical = [];
    for (let i = 0; i < count; i++) {
      const index = offset + i;
      const raw = table.record(index, context) || {};
      for (const name of formulaNames) delete raw[name];
      hash.update(JSON.stringify(raw));
      hash.update('\n');
      logical.push(raw);
    }
    const records = logical.map((fields) => ({ fields: resolveFields(fields) }));
    const response = await request('POST', `/api/table/${encodeURIComponent(state.id)}/record`, {
      fieldKeyType: 'name',
      typecast: false,
      records,
    });
    for (const record of response?.records || []) {
      if (record?.id) ids.push(record.id);
    }
    if (ids.length === table.count || ids.length % (batchSize * 10) === 0) {
      log(`${table.key}: ${ids.length}/${table.count}`);
    }
  }
  idsByTable.set(table.key, ids);
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const checksums = {};
for (const [key, hash] of hashes) checksums[key] = hash.digest('hex');
const overall = createHash('sha256');
for (const [key, value] of Object.entries(checksums)) {
  overall.update(key);
  overall.update(value);
}

const tables = {};
for (const table of profile.tables) {
  const state = tableStates.get(table.key);
  tables[table.key] = { id: state.id, name: state.name, fields: state.fields, count: table.count };
}

const cmdArgs = process.argv.slice(2).join(' ');
const schema = {
  datasetId: profile.datasetId,
  domain: profile.domain,
  description: profile.description,
  primary: profile.primary,
  distribution: profile.distribution,
  computedFields: computedOk,
  counts,
  tables,
};

const ids = { ...Object.fromEntries(idsByTable), tables: Object.fromEntries(profile.tables.map((table) => [table.key, tableStates.get(table.key).id])) };
const workloads = profile.workloads.map((workload) => {
  const state = tableStates.get(workload.table);
  const field = state.fields.find((item) => item.name === workload.field);
  return {
    ...workload,
    tableId: state.id,
    fieldId: field?.id,
    count: state.count,
    recordIdsFile: `${outDir}/${profile.datasetId}.${workload.table}.ids.json`,
    updateExample: { [workload.field]: `stress-${profile.domain}` },
  };
});

const datasetRecord = {
  数据集ID: profile.datasetId,
  环境: env,
  存储: args.storage || 'default',
  数据集类型: 'synthetic',
  Base数量: 1,
  表数量: profile.tables.length,
  主表行数: tableStates.get(profile.primary).count,
  最大表行数: Math.max(...profile.tables.map((table) => table.count)),
  字段数: profile.tables.reduce((sum, table) => sum + tableStates.get(table.key).fields.length, 0),
  字段配置: profile.tables.map((table) => `${table.key}(${tableStates.get(table.key).fields.length})`).join('; '),
  数据分布: profile.distribution,
  生成方式: 'api',
  生成脚本: `node stress-tests/tools/business-data.mjs ${cmdArgs}`.trim(),
  校验和: overall.digest('hex'),
  创建时间: new Date().toISOString(),
  备注: `tables=${JSON.stringify(Object.fromEntries(profile.tables.map((table) => [table.key, tableStates.get(table.key).id])))}; computedFields=${computedOk}; elapsed=${elapsed}s`,
  证据键: `ds:${profile.datasetId}`,
};

const basePath = `${outDir}/${profile.datasetId}`;
await writeFile(`${basePath}.schema.json`, JSON.stringify(schema, null, 2));
await writeFile(`${basePath}.ids.json`, JSON.stringify(ids, null, 2));
await writeFile(`${basePath}.workloads.json`, JSON.stringify(workloads, null, 2));
for (const table of profile.tables) {
  await writeFile(`${basePath}.${table.key}.ids.json`, JSON.stringify(tableIdList(table.key, table.count)));
}
await writeFile(`${basePath}.dataset-record.json`, JSON.stringify(datasetRecord, null, 2));
await writeFile(
  `${basePath}.summary.json`,
  JSON.stringify(
    {
      datasetId: profile.datasetId,
      domain: profile.domain,
      counts,
      checksums,
      computedFields: computedOk,
      elapsedSeconds: Number(elapsed),
      files: {
        schema: `${basePath}.schema.json`,
        ids: `${basePath}.ids.json`,
        workloads: `${basePath}.workloads.json`,
        datasetRecord: `${basePath}.dataset-record.json`,
      },
    },
    null,
    2
  )
);

log(`done in ${elapsed}s`);
log(`tables: ${JSON.stringify(ids.tables)}`);
log(`checksum: ${datasetRecord['校验和']}`);
log(`files: ${basePath}.{schema,ids,workloads,dataset-record,summary}.json`);
