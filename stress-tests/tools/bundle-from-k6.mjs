#!/usr/bin/env node
// Build a portable stress-evidence bundle from a k6 summary JSON. Persistent recording and verdict policy live in teable-perf-lab.
// Usage:
//   node stress-tests/tools/bundle-from-k6.mjs \
//     --summary summary-read.json --out run-bundle.json \
//     --run-id lst_... --env staging --category core --test-type load \
//     --scenario-set readmix_v1 --dataset-key ds_small_v1 \
//     --scenario-id core.crud.list_plain --scenario record_list \
//     --mode shared --repeat 1 --target-rps 50 --code-version abc1234

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
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
if (!args.summary || !args['run-id']) {
  console.error('--summary and --run-id are required');
  process.exit(2);
}
if (!args['scenario-id'] && !args['catalog-id']) {
  console.error('--scenario-id or --catalog-id is required for a canonical evidence bundle');
  process.exit(2);
}

const summary = JSON.parse(await readFile(resolve(args.summary), 'utf8'));
const metrics = summary.metrics || {};
const now = new Date().toISOString();
const started = args.start || now;
const ended = args.end || now;
const durationSec = Number(args['duration-sec'] || 0);
const runId = args['run-id'];
const scenarioId = args['scenario-id'] || args['catalog-id'];
const targetRps = args['target-rps'] ? Number(args['target-rps']) : undefined;
const repeat = args.repeat ? Number(args.repeat) : 1;
const mode = args.mode || 'shared';
if (!Number.isInteger(repeat) || repeat < 1) {
  console.error('--repeat must be a positive integer');
  process.exit(2);
}
if (mode !== 'shared' && mode !== 'byodb') {
  console.error('--mode must be shared or byodb');
  process.exit(2);
}

function value(name, key, fallback) {
  const metric = metrics[name];
  if (!metric) return fallback;
  const values = metric.values || {};
  return values[key] === undefined ? fallback : values[key];
}

const opDurationKeys = Object.keys(metrics).filter((key) =>
  key.startsWith('teable_op_duration{op:')
);
const opFailures = value('teable_op_failures', 'count', 0);

function scenarioForOp(op) {
  const map = {
    list: 'record_list',
    get: 'record_get',
    create: 'record_create',
    update: 'record_update',
    delete: 'record_delete',
    update_many: 'batch_update',
    delete_many: 'batch_delete',
    computed_update: 'computed_fanout',
    search: 'search',
    ai: 'mixed_workload',
  };
  return map[op] || args.scenario || 'mixed_workload';
}

const scenarios = [];
if (opDurationKeys.length === 0) {
  scenarios.push({
    scenarioId,
    catalogId: scenarioId,
    scenario: args.scenario || 'mixed_workload',
    mode,
    repeat,
    category: args.category || 'core',
    loadModel: 'open_arrival',
    targetRps: targetRps,
    durationSec: durationSec || undefined,
    requests: value('http_reqs', 'count', 0),
    success: Math.round(value('http_reqs', 'count', 0) * (1 - value('http_req_failed', 'rate', 0))),
    failed: Math.round(value('http_reqs', 'count', 0) * value('http_req_failed', 'rate', 0)),
    successRate: Number(((1 - value('http_req_failed', 'rate', 0)) * 100).toFixed(2)),
    p50: value('http_req_duration', 'p(50)', value('http_req_duration', 'med')),
    p95: value('http_req_duration', 'p(95)'),
    p99: value('http_req_duration', 'p(99)'),
    p999: value('http_req_duration', 'p(99.9)'),
    errorRate: Number((value('http_req_failed', 'rate', 0) * 100).toFixed(3)),
    verdict: 'inconclusive',
    notes: 'generated from k6 summary; add server-side metrics and conclusion',
  });
} else {
  for (const key of opDurationKeys) {
    const match = key.match(/op:([^}]+)/);
    const op = match ? match[1] : 'unknown';
    const count = value(key, 'count', 0);
    const failed = opFailures ? Math.round(opFailures / opDurationKeys.length) : 0;
    scenarios.push({
      scenarioId,
      catalogId: scenarioId,
      scenario: scenarioForOp(op),
      operationKey: op,
      mode,
      repeat,
      category: args.category || 'core',
      loadModel: 'open_arrival',
      targetRps: targetRps,
      durationSec: durationSec || undefined,
      requests: count,
      success: Math.max(0, count - failed),
      failed: failed,
      successRate: count ? Number((((count - failed) / count) * 100).toFixed(2)) : 0,
      p50: value(key, 'p(50)', value(key, 'med')),
      p95: value(key, 'p(95)'),
      p99: value(key, 'p(99)'),
      p999: value(key, 'p(99.9)'),
      errorRate: count ? Number(((failed / count) * 100).toFixed(3)) : 0,
      verdict: 'inconclusive',
      notes: `k6 op=${op}; generated from summary`,
    });
  }
}

const totalRequests = scenarios.reduce((sum, item) => sum + (item.requests || 0), 0);
const totalSuccess = scenarios.reduce((sum, item) => sum + (item.success || 0), 0);
const run = {
  runId,
  environment: args.env || 'staging',
  category: args.category || 'core',
  testType: args['test-type'] || 'load',
  scenarioSet: args['scenario-set'] || 'k6',
  status: args.status || 'success',
  verdict: args.verdict || 'inconclusive',
  datasetKey: args['dataset-key'] || undefined,
  scenarioId,
  specVersion: args['spec-version'] || 'v1',
  mode,
  repeat,
  loadModel: 'open_arrival',
  targetRps: targetRps,
  peakRps: args['peak-rps'] ? Number(args['peak-rps']) : undefined,
  totalRequests,
  successRate: totalRequests ? Number(((totalSuccess / totalRequests) * 100).toFixed(2)) : 0,
  p95: value('http_req_duration', 'p(95)'),
  p99: value('http_req_duration', 'p(99)'),
  startTime: started,
  endTime: ended,
  windowStart: started,
  windowEnd: ended,
  codeVersion: args['code-version'] || '',
  environmentBaseline: args['environment-baseline'] || '',
  conclusion: args.conclusion || '',
  reportUrl: args['report-url'] || '',
  artifactUrl: args['artifact-url'] || '',
  bottleneckSummary: args['bottleneck-summary'] || '',
  collectionStatus: 'observed',
  schemaVersion: 'stress-evidence-v2',
  notes: args.notes || 'generated from k6 summary',
  budgetStatus: args.category === 'ai' ? args['budget-status'] || 'unknown' : 'not_applicable',
  aiBudgetUsd: args['ai-budget-usd'] ? Number(args['ai-budget-usd']) : undefined,
  actualAiCostUsd: args['actual-ai-cost-usd'] ? Number(args['actual-ai-cost-usd']) : undefined,
  totalTokens: value('ai_tokens_total', 'count'),
};

const bundle = {
  run,
  scenarios,
  metrics: [
    {
      scenarioId,
      specVersion: run.specVersion,
      mode,
      repeat,
      scenario: scenarios[0]?.scenario || args.scenario || 'all',
      metric: 'k6.dropped_iterations',
      metricKey: 'k6.dropped_iterations',
      metricType: 'saturation',
      environment: run.environment,
      serviceInstance: 'load-generator',
      windowStart: started,
      windowEnd: ended,
      value: value('dropped_iterations', 'count', 0),
      threshold: 100,
      overThreshold: value('dropped_iterations', 'count', 0) > 100,
      unit: 'count',
      samples: 1,
      status: value('dropped_iterations', 'count', 0) > 100 ? 'degraded' : 'healthy',
      collectionStatus: 'observed',
      source: 'k6',
      queryReceipt: 'k6 summary metrics.dropped_iterations',
      sourceUrl: args['artifact-url'] || '',
      category: run.category,
    },
  ],
  bottlenecks: [],
};

const outPath = resolve(args.out || 'run-bundle.json');
await mkdir(dirname(outPath), { recursive: true });
await writeFile(outPath, JSON.stringify(bundle, null, 2));
console.log(`bundle written: ${outPath}`);
console.log(`scenarios: ${scenarios.length}, requests: ${totalRequests}`);
