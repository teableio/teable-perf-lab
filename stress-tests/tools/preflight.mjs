#!/usr/bin/env node
// Preflight for a stress-test target. Read-only: never creates or updates records.
// Usage:
//   BASE_URL=https://staging.example.com TEABLE_TOKEN=... TABLE_ID=tbl... VIEW_ID=viw... \
//     node stress-tests/tools/preflight.mjs

import process from 'node:process';

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
const tableId = args['table-id'] || process.env.TABLE_ID || '';
const viewId = args['view-id'] || process.env.VIEW_ID || '';
const apiKind = args['api-kind'] || process.env.API_KIND || 'v1';
const jsonOut = Boolean(args.json);

const checks = [];

async function call(method, path) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, ok: res.ok, body };
}

function record(name, ok, detail, required = true) {
  checks.push({ name, ok, required, detail });
}

if (!baseUrl || !token || !tableId) {
  console.error('BASE_URL, TEABLE_TOKEN and TABLE_ID are required.');
  process.exit(2);
}

record('config', true, { baseUrl, tableId, viewId: viewId || null, apiKind });

try {
  if (apiKind === 'v2') {
    const table = await call('GET', `/api/v2/tables/get?tableId=${encodeURIComponent(tableId)}`);
    record('table read', table.ok, { status: table.status, name: table.body?.name });
    const list = await call(
      'GET',
      `/api/v2/tables/listRecords?tableId=${encodeURIComponent(tableId)}&limit=1&fieldKeyType=name${viewId ? `&viewId=${encodeURIComponent(viewId)}` : ''}`
    );
    record('record list', list.ok, {
      status: list.status,
      records: Array.isArray(list.body?.records) ? list.body.records.length : null,
    });
    if (viewId) {
      const views = await call('GET', `/api/v2/tables/listViews?tableId=${encodeURIComponent(tableId)}`);
      const found = Array.isArray(views.body) && views.body.some((v) => v.id === viewId);
      record('view exists', views.ok && found, { status: views.status, found });
    }
  } else {
    const table = await call('GET', `/api/table/${encodeURIComponent(tableId)}`);
    record('table read', table.ok, { status: table.status, name: table.body?.name });
    const list = await call(
      'GET',
      `/api/table/${encodeURIComponent(tableId)}/record?take=1${viewId ? `&viewId=${encodeURIComponent(viewId)}` : ''}`
    );
    record('record list', list.ok, {
      status: list.status,
      records: Array.isArray(list.body?.records) ? list.body.records.length : null,
    });
    if (viewId) {
      const views = await call('GET', `/api/table/${encodeURIComponent(tableId)}/view`);
      const found = Array.isArray(views.body) && views.body.some((v) => v.id === viewId);
      record('view exists', views.ok && found, { status: views.status, found });
    }
  }
} catch (error) {
  record('network', false, { error: error.message });
}

const requiredFailures = checks.filter((c) => c.required && !c.ok);
const result = {
  ok: requiredFailures.length === 0,
  baseUrl,
  tableId,
  viewId: viewId || null,
  apiKind,
  checks,
  warnings: checks.filter((c) => !c.required && !c.ok).map((c) => c.name),
};

if (jsonOut) {
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(`preflight: ${result.ok ? 'PASS' : 'FAIL'}`);
  for (const check of checks) {
    console.log(`${check.ok ? 'ok  ' : 'FAIL'} ${check.name} ${JSON.stringify(check.detail)}`);
  }
}

process.exit(result.ok ? 0 : 1);
