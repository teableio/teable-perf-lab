import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMockTeable } from './mock-teable-api.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const tools = join(here, '..', 'tools');
const fixtures = join(here, 'fixtures');

function runNode(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function postJson(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function createTable(port, { id, name, fields }) {
  return postJson(port, '/api/base/test/table/', { id, name, fields });
}


test('preflight reads v1 and v2 metadata without writes', async () => {
  const mock = await startMockTeable({ port: 0 });
  try {
    await createTable(mock.port, {
      id: 'tbl_preflight',
      name: 'Preflight',
      fields: [{ id: 'fld_name', name: 'Name', type: 'singleLineText' }],
    });
    const env = {
      BASE_URL: `http://127.0.0.1:${mock.port}`,
      TEABLE_TOKEN: 'test',
      TABLE_ID: 'tbl_preflight',
      VIEW_ID: 'viw_mock',
    };

    const v1 = await runNode([join(tools, 'preflight.mjs'), '--json'], env);
    assert.equal(v1.code, 0, v1.stderr);
    const v1Result = JSON.parse(v1.stdout);
    assert.equal(v1Result.ok, true);
    assert.equal(v1Result.checks.find((c) => c.name === 'table read').ok, true);

    const v2 = await runNode([join(tools, 'preflight.mjs'), '--json'], {
      ...env,
      API_KIND: 'v2',
    });
    assert.equal(v2.code, 0, v2.stderr);
    assert.equal(JSON.parse(v2.stdout).ok, true);
  } finally {
    await mock.close();
  }
});

test('seed creates a table, batches records, and writes a dataset receipt', async () => {
  const mock = await startMockTeable({ port: 0 });
  const outDir = await mkdtemp(join(tmpdir(), 'stress-seed-'));
  try {
    const result = await runNode(
      [
        join(tools, 'seed.mjs'),
        '--manifest',
        join(here, '..', 'datasets', 'small.json'),
        '--limit',
        '20',
        '--batch-size',
        '10',
        '--out-dir',
        outDir,
      ],
      {
        BASE_URL: `http://127.0.0.1:${mock.port}`,
        TEABLE_TOKEN: 'test',
        TEABLE_BASE_ID: 'bse_mock',
      }
    );
    assert.equal(result.code, 0, result.stderr);

    const dataset = JSON.parse(
      await readFile(join(outDir, 'ds_small_v1.dataset-record.json'), 'utf8')
    );
    assert.equal(dataset['主表行数'], 20);
    assert.equal(dataset['字段数'], 30);
    assert.equal(dataset['校验和'].length, 64);

    const ids = JSON.parse(await readFile(join(outDir, 'ds_small_v1.ids.json'), 'utf8'));
    assert.equal(ids.length, 20);

    const recordPosts = mock.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/record')
    );
    assert.equal(recordPosts.length, 2);
    assert.deepEqual(recordPosts.map((r) => r.body.records.length), [10, 10]);
  } finally {
    await mock.close();
  }
});



function waitForOutput(child, needle, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${needle}`)), timeoutMs);
    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.includes(needle)) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(buffer);
      }
    };
    child.stdout.on('data', onData);
    child.on('error', reject);
  });
}

test('AI mock provider reports zero-cost simulated usage', async () => {
  const port = 19000 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [join(tools, 'ai-mock-server.mjs')], {
    env: {
      ...process.env,
      PORT: String(port),
      MOCK_PROMPT_TOKENS: '12',
      MOCK_COMPLETION_TOKENS: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForOutput(child, 'AI_MOCK_LISTENING');
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 8,
      }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.usage.prompt_tokens, 12);
    assert.equal(body.usage.completion_tokens, 8);
    assert.equal(body.usage.total_tokens, 20);

    const stats = await (await fetch(`http://127.0.0.1:${port}/stats`)).json();
    assert.equal(stats.requests, 1);
    assert.equal(stats.totalTokens, 20);
  } finally {
    child.kill('SIGTERM');
  }
});

test('bundle-from-k6 maps a summary into a run bundle', async () => {
  const outDir = await mkdtemp(join(tmpdir(), 'stress-bundle-'));
  const out = join(outDir, 'bundle.json');
  const result = await runNode([
    join(tools, 'bundle-from-k6.mjs'),
    '--summary',
    join(fixtures, 'k6-summary.json'),
    '--out',
    out,
    '--run-id',
    'lst_test',
    '--catalog-id',
    'core.crud.list_plain',
    '--scenario',
    'record_list',
    '--target-rps',
    '5',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const bundle = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(bundle.run.runId, 'lst_test');
  assert.equal(bundle.scenarios.length, 1);
  assert.equal(bundle.scenarios[0].requests, 100);
  assert.equal(bundle.scenarios[0].p95, 420);
  assert.equal(bundle.metrics[0].metric, 'k6.dropped_iterations');
  assert.equal(bundle.run.schemaVersion, 'stress-evidence-v2');
  assert.equal(bundle.run.scenarioId, 'core.crud.list_plain');
  assert.equal(bundle.run.mode, 'shared');
  assert.equal(bundle.run.repeat, 1);
  assert.equal(bundle.scenarios[0].scenarioId, 'core.crud.list_plain');
  assert.equal(bundle.metrics[0].metricKey, 'k6.dropped_iterations');
});

test('business generator creates linked CRM/order tables with adjustable volume', async () => {
  const mock = await startMockTeable({ port: 0 });
  const outDir = await mkdtemp(join(tmpdir(), 'stress-business-'));
  try {
    const result = await runNode(
      [
        join(tools, 'business-data.mjs'),
        '--domain',
        'crm',
        '--customers',
        '5',
        '--orders-per-customer',
        '2',
        '--items-per-order',
        '2',
        '--products',
        '8',
        '--contacts-per-customer',
        '1',
        '--batch-size',
        '4',
        '--dataset-id',
        'ds_biz_test_v1',
        '--out-dir',
        outDir,
      ],
      {
        BASE_URL: `http://127.0.0.1:${mock.port}`,
        TEABLE_TOKEN: 'test',
        TEABLE_BASE_ID: 'bse_mock',
      }
    );
    assert.equal(result.code, 0, result.stderr);
    const ids = JSON.parse(
      await readFile(join(outDir, 'ds_biz_test_v1.ids.json'), 'utf8')
    );
    assert.equal(ids.products.length, 8);
    assert.equal(ids.customers.length, 5);
    assert.equal(ids.orders.length, 10);
    assert.equal(ids.orderItems.length, 20);
    assert.equal(ids.contacts.length, 5);

    const summary = JSON.parse(
      await readFile(join(outDir, 'ds_biz_test_v1.summary.json'), 'utf8')
    );
    assert.equal(summary.counts.customers, 5);
    assert.equal(summary.counts['orders-per-customer'], 2);
    assert.equal(summary.computedFields, true);

    const fieldPosts = mock.requests.filter(
      (r) => r.method === 'POST' && r.path.endsWith('/field')
    );
    assert.deepEqual(fieldPosts.map((r) => r.body.name).sort(), ['LineTotal', 'NetTotal']);
  } finally {
    await mock.close();
  }
});

test('all business profiles load, plan, and dry-run', async () => {
  for (const domain of ['crm', 'ecommerce', 'project', 'hr']) {
    const plan = await runNode([join(tools, 'business-data.mjs'), '--domain', domain, '--plan']);
    assert.equal(plan.code, 0, `${domain} plan: ${plan.stderr}`);
    assert.match(plan.stdout, new RegExp(`business dataset ${domain}`));
    const dry = await runNode([join(tools, 'business-data.mjs'), '--domain', domain, '--dry-run']);
    assert.equal(dry.code, 0, `${domain} dry-run: ${dry.stderr}`);
    assert.match(dry.stdout, /sample /);
  }
});

test('ecommerce, project, and hr seed linked tables against the mock API', async () => {
  const mock = await startMockTeable({ port: 0 });
  const cases = [
    {
      domain: 'ecommerce',
      args: ['--products', '4', '--customers', '3', '--orders-per-customer', '2', '--items-per-order', '2', '--warehouses', '2', '--return-every', '2'],
      expected: { products: 4, customers: 3, orders: 6, orderItems: 12, inventory: 8 },
    },
    {
      domain: 'project',
      args: ['--teams', '2', '--members-per-team', '2', '--projects-per-team', '1', '--tasks-per-project', '2', '--entries-per-task', '1'],
      expected: { teams: 2, members: 4, projects: 2, tasks: 4, timeEntries: 4 },
    },
    {
      domain: 'hr',
      args: ['--departments', '2', '--employees-per-department', '2', '--leave-requests-per-employee', '1', '--reviews-per-employee', '1', '--payroll-periods', '1'],
      expected: { departments: 2, employees: 4, leaveRequests: 4, reviews: 4, payroll: 4 },
    },
  ];
  try {
    for (const item of cases) {
      const outDir = await mkdtemp(join(tmpdir(), `stress-${item.domain}-`));
      const datasetId = `ds_${item.domain}_test_v1`;
      const result = await runNode(
        [
          join(tools, 'business-data.mjs'),
          '--domain',
          item.domain,
          ...item.args,
          '--batch-size',
          '10',
          '--prefix',
          `t_${item.domain}`,
          '--dataset-id',
          datasetId,
          '--out-dir',
          outDir,
        ],
        {
          BASE_URL: `http://127.0.0.1:${mock.port}`,
          TEABLE_TOKEN: 'test',
          TEABLE_BASE_ID: 'bse_mock',
        }
      );
      assert.equal(result.code, 0, `${item.domain}: ${result.stderr}`);
      const ids = JSON.parse(await readFile(join(outDir, `${datasetId}.ids.json`), 'utf8'));
      for (const [table, count] of Object.entries(item.expected)) {
        assert.equal(ids[table].length, count, `${item.domain}.${table}`);
      }
      const summary = JSON.parse(
        await readFile(join(outDir, `${datasetId}.summary.json`), 'utf8')
      );
      assert.equal(summary.computedFields, true, `${item.domain} computed fields`);
    }
  } finally {
    await mock.close();
  }
});