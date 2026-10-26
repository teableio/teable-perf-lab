#!/usr/bin/env node
// Create a Teable table from a dataset manifest and seed deterministic rows via the record API.
// Usage:
//   BASE_URL=https://staging.example.com TEABLE_TOKEN=... TEABLE_BASE_ID=bse... \
//     node stress-tests/tools/seed.mjs --manifest stress-tests/datasets/small.json --limit 1000
// The API seeder is for small/medium datasets. Large datasets should use snapshot restore or devtools.

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
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
const manifestArg = args.manifest;
if (!manifestArg) {
  console.error('Missing --manifest');
  process.exit(2);
}
const manifestPath = resolve(manifestArg);

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const baseUrl = (args['base-url'] || process.env.BASE_URL || '').replace(/\/+$/, '');
const token = args.token || process.env.TEABLE_TOKEN || process.env.TOKEN || '';
const baseId = args['base-id'] || process.env.TEABLE_BASE_ID || '';
const env = args.env || process.env.STRESS_ENV || 'staging';
const tableName = args['table-name'] || manifest.table.name;
const batchSize = Number(args['batch-size'] || manifest.generation?.batchSize || 500);
const limit = args.limit ? Number(args.limit) : manifest.rows;
const seed = Number(args.seed || manifest.generation?.seed || 42);
const prefix = args.prefix || manifest.name || 'stress';
const outDir = resolve(args['out-dir'] || 'stress-tests/out');
const dryRun = Boolean(args['dry-run']);
const planOnly = Boolean(args.plan);
const forceApi = Boolean(args['force-api']);

if (!planOnly && !dryRun) {
  if (!baseUrl || !token || !baseId) {
    fail('BASE_URL, TEABLE_TOKEN and TEABLE_BASE_ID are required (or use --plan / --dry-run).');
  }
}

function expandFields(table) {
  const fields = [...table.fields];
  for (const group of table.repeat || []) {
    for (let i = 0; i < group.count; i++) {
      const suffix = String(i + 1).padStart(2, '0');
      const field = { name: `${group.namePrefix}${suffix}`, type: group.type };
      if (group.options) field.options = group.options;
      fields.push(field);
    }
  }
  return fields;
}

const fields = expandFields(manifest.table);

function log(message) {
  process.stdout.write(`[seed] ${message}\n`);
}

function fail(message) {
  console.error(`[seed] ERROR: ${message}`);
  process.exit(1);
}

function fieldOptionsForCreate(field) {
  if (field.type === 'singleSelect' || field.type === 'multipleSelect') {
    return { choices: (field.options?.choices || []).map((c) => ({ name: c.name })) };
  }
  if (field.type === 'rating') {
    return field.options || { icon: 'star', color: 'yellowBright', max: 5 };
  }
  return undefined;
}

function createFieldsPayload() {
  return fields.map((field) => {
    const options = fieldOptionsForCreate(field);
    return options ? { name: field.name, type: field.type, options } : { name: field.name, type: field.type };
  });
}

function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dateFor(index) {
  const base = Date.UTC(2026, 0, 1);
  const d = new Date(base + (index % 365) * 86400000);
  return d.toISOString();
}

function choicesFor(field) {
  return (field.options?.choices || []).map((c) => c.name);
}

function valueFor(field, index, fieldIndex) {
  const rng = mulberry32((seed ^ (index * 2654435761) ^ (fieldIndex * 40503)) >>> 0);
  const name = field.name;

  if (name === 'Name') return `${prefix}-${String(index).padStart(7, '0')}`;
  if (name === 'Email') return `user${index}@example.test`;
  if (name === 'Notes') return `note-${index}-${rng().toString(36).slice(2, 8)}`;

  switch (field.type) {
    case 'singleLineText':
      return `${name.toLowerCase()}-${index}-${rng().toString(36).slice(2, 8)}`;
    case 'longText':
      return `${name.toLowerCase()}-${index}-${rng().toString(36).slice(2, 12)}`;
    case 'number':
      return Math.round(rng() * 1000000) / 100;
    case 'rating':
      return (index % 5) + 1;
    case 'checkbox':
      return rng() > 0.5;
    case 'date':
      return dateFor(index + fieldIndex);
    case 'singleSelect': {
      const choices = choicesFor(field);
      return choices.length ? choices[index % choices.length] : '';
    }
    case 'multipleSelect': {
      const choices = choicesFor(field);
      if (!choices.length) return [];
      const first = choices[index % choices.length];
      const second = choices[(index + fieldIndex + 1) % choices.length];
      return first === second ? [first] : [first, second];
    }
    default:
      return `${name}-${index}`;
  }
}

function makeRecord(index) {
  const record = {};
  fields.forEach((field, fieldIndex) => {
    record[field.name] = valueFor(field, index, fieldIndex);
  });
  return { fields: record };
}

async function request(method, path, body, expected) {
  const url = `${baseUrl}${path}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (res.ok) {
        const text = await res.text();
        return text ? JSON.parse(text) : null;
      }
      const text = await res.text();
      if (expected && expected.includes(res.status)) return { status: res.status, text };
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastError;
}

function printPlan() {
  log(`manifest: ${manifest.id} (${manifest.name})`);
  log(`rows: ${limit}${limit !== manifest.rows ? ` (override, manifest ${manifest.rows})` : ''}`);
  log(`fields: ${fields.length}`);
  log(`table: ${tableName}`);
  log(`method: ${manifest.method}${forceApi ? ' (forced api)' : ''}`);
  log(`base: ${baseId || '(missing TEABLE_BASE_ID)'}`);
  log(`baseUrl: ${baseUrl || '(missing BASE_URL)'}`);
  if (manifest.method !== 'api' && !forceApi) {
    log('This manifest is not an API-seed dataset.');
    if (manifest.method === 'devtools') {
      log('Use v2 devtools mock generate or direct DB seeding; then write the dataset record manually.');
    } else if (manifest.method === 'snapshot') {
      log('Use a snapshot restore of a production-like dataset; do not generate 10M rows through the API.');
    }
    return false;
  }
  return true;
}


log(`manifest ${manifest.id}: ${fields.length} fields, ${limit} rows, method=${manifest.method}`);
if (dryRun) {
  log('sample records:');
  for (let i = 0; i < 2; i++) log(JSON.stringify(makeRecord(i)));
  process.exit(0);
}
if (planOnly) {
  printPlan();
  process.exit(0);
}
if (manifest.method !== 'api' && !forceApi) {
  printPlan();
  process.exit(0);
}

await mkdir(outDir, { recursive: true });

let tableId = args['table-id'] || '';
if (!tableId) {
  log(`creating table ${tableName}`);
  const created = await request('POST', `/api/base/${encodeURIComponent(baseId)}/table/`, {
    name: tableName,
    fields: createFieldsPayload(),
  });
  tableId = created?.id;
  if (!tableId) fail('table creation returned no id');
  log(`table created: ${tableId}`);
} else {
  log(`reusing table: ${tableId}`);
}

const hash = createHash('sha256');
const ids = [];
const startedAt = Date.now();
let inserted = 0;

for (let offset = 0; offset < limit; offset += batchSize) {
  const count = Math.min(batchSize, limit - offset);
  const records = [];
  for (let i = 0; i < count; i++) {
    const index = offset + i;
    const record = makeRecord(index);
    records.push(record);
    hash.update(JSON.stringify(record.fields));
    hash.update('\n');
  }
  const response = await request('POST', `/api/table/${encodeURIComponent(tableId)}/record`, {
    fieldKeyType: 'name',
    typecast: false,
    records,
  });
  for (const record of response?.records || []) {
    if (record?.id) ids.push(record.id);
  }
  inserted += count;
  if (offset === 0 || inserted % (batchSize * 10) === 0 || inserted === limit) {
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
    log(`inserted ${inserted}/${limit} (${elapsed}s)`);
  }
}

const checksum = hash.digest('hex');
const idsPath = resolve(args['ids-file'] || `${outDir}/${manifest.id}.ids.json`);
const datasetRecordPath = resolve(`${outDir}/${manifest.id}.dataset-record.json`);

await mkdir(dirname(idsPath), { recursive: true });
await writeFile(idsPath, JSON.stringify(ids));
const datasetRecord = {
  数据集ID: manifest.id,
  环境: env,
  存储: args.storage || 'default',
  数据集类型: 'synthetic',
  Base数量: 1,
  表数量: 1,
  主表行数: inserted,
  最大表行数: inserted,
  字段数: fields.length,
  字段配置: fields.map((f) => `${f.name}:${f.type}`).join(', '),
  数据分布: `deterministic seed=${seed}; uniform; ${manifest.description || ''}`.trim(),
  生成方式: 'api',
  生成脚本: `stress-tests/tools/seed.mjs --manifest ${manifestPath} --limit ${limit}`,
  校验和: checksum,
  创建时间: new Date().toISOString(),
  备注: `tableId=${tableId}; ids=${idsPath}`,
  证据键: `ds:${manifest.id}`,
};
await writeFile(datasetRecordPath, JSON.stringify(datasetRecord, null, 2));

log(`done: tableId=${tableId}, rows=${inserted}, checksum=${checksum}`);
log(`ids: ${idsPath}`);
log(`dataset record: ${datasetRecordPath}`);
