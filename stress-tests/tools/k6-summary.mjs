#!/usr/bin/env node
// Compact C0 extractor for k6 outputs.
//
// Inputs:
//   <summary.json>   k6 end-of-test summary (handleSummary / --summary-export).
//   --raw <ndjson>   k6 raw JSON output produced by `k6 run --out json=<path>`.
//                    Strongly required for C0: exact phase/op quantiles,
//                    per-operation status + x-teable-v2 buckets, and failure
//                    breakdowns by safe body error code / v2 feature.
//   --meta <json>    companion run metadata written by c0-breakpoint.js
//                    (${SUMMARY_PATH%.json}.run.json). Auto-detected.
//
// Usage:
//   node stress-tests/tools/k6-summary.mjs summary-s25.json --raw raw-s25.ndjson
//
// Options:
//   --raw <path>       raw k6 NDJSON (or auto from meta.rawOutput.path)
//   --meta <path>      run metadata (default: <summary>.run.json)
//   --out <path>       also write the JSON object to this path
//   --min-samples <n>  minimum samples before a guardrail is evaluated (default 100)
//   --strict           exit 1 if any non-core metric is missing
//   --fail-on-breach   exit 3 when an evaluable guardrail is breached
//   --ops              accepted for backward compatibility (ops are always emitted)
//
// Exit codes:
//   0  extracted; core metrics present and guardrails not failed (or not requested)
//   1  core metric/breakdown missing, raw file malformed, or --strict missing data
//   2  usage/input error
//   3  evaluable guardrail breached and --fail-on-breach was passed
//
// The tool never prints response bodies, messages, headers, or URLs. Failure
// categories use only status, safe body error code (c0_http_failures), and the
// safe x-teable-v2-feature value. Missing data is explicit: see `missing`,
// `coreMissing`, `warnings`, and `sources` in the output.

import { createReadStream, existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import process from 'node:process';

const SCHEMA = 'c0-k6-summary/v2';
const EXPECTED_OPS = ['list', 'get', 'create', 'update', 'computed'];
const EXPECTED_PHASES = ['warm', 'ramp', 'plateau', 'drain'];
const DEFAULT_MIN_SAMPLES = 100;
const ERROR_RATE_MAX = 0.01;
const P99_MAX_MS = 2000;
const PLATEAU_P95_MAX_MS = 1000;

function die(message, code = 2) {
  console.error(message);
  process.exit(code);
}

function parseArgs(argv) {
  const opts = {
    summary: '',
    raw: '',
    meta: '',
    out: '',
    strict: false,
    failOnBreach: false,
    minSamples: DEFAULT_MIN_SAMPLES,
    ops: false,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: k6-summary.mjs <summary.json> [--raw <raw.ndjson>] [--meta <run-meta.json>] ' +
          '[--out <path>] [--min-samples <n>] [--strict] [--fail-on-breach] [--ops]'
      );
      process.exit(0);
    }
    if (arg === '--strict') {
      opts.strict = true;
      continue;
    }
    if (arg === '--fail-on-breach') {
      opts.failOnBreach = true;
      continue;
    }
    if (arg === '--ops') {
      opts.ops = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      let value = eq >= 0 ? arg.slice(eq + 1) : '';
      if (eq < 0) {
        value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) die(`Missing value for --${key}`);
        i++;
      }
      if (key === 'raw') opts.raw = value;
      else if (key === 'meta') opts.meta = value;
      else if (key === 'out') opts.out = value;
      else if (key === 'min-samples') {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1) die(`--min-samples must be a positive integer, got ${value}`);
        opts.minSamples = n;
      } else die(`Unknown option --${key}`);
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 1) die('usage: k6-summary.mjs <summary.json> [--raw <raw.ndjson>]');
  opts.summary = positional[0];
  return opts;
}

function metaPathFor(summaryPath) {
  if (/\.json$/i.test(summaryPath)) return summaryPath.replace(/\.json$/i, '.run.json');
  return summaryPath + '.run.json';
}

function round3(n) {
  if (n === null || n === undefined || !Number.isFinite(n)) return null;
  return Math.round(n * 1000) / 1000;
}

function inc(obj, key) {
  const k = key === undefined || key === null || key === '' ? 'missing' : String(key);
  obj[k] = (obj[k] || 0) + 1;
}

function sortObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) out[key] = obj[key];
  return out;
}

function zeroV2Buckets() {
  return { true: 0, false: 0, missing: 0, other: 0 };
}

function v2ForOp(state, op) {
  const buckets = state.v2.byOp[op];
  if (!buckets) return { present: false, ...zeroV2Buckets() };
  return { present: true, ...buckets };
}

function normalizeV2(value) {
  const v = String(value === undefined || value === null ? 'missing' : value).toLowerCase();
  if (v === 'true' || v === 'false' || v === 'missing') return v;
  if (v === '') return 'missing';
  return 'other';
}

function quantile(sorted, q) {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function stats(values) {
  if (!values || values.length === 0) {
    return { count: 0, min: null, avg: null, p50: null, p90: null, p95: null, p99: null, p999: null, max: null };
  }
  values.sort((a, b) => a - b);
  let sum = 0;
  for (let i = 0; i < values.length; i++) sum += values[i];
  return {
    count: values.length,
    min: round3(values[0]),
    avg: round3(sum / values.length),
    p50: round3(quantile(values, 0.5)),
    p90: round3(quantile(values, 0.9)),
    p95: round3(quantile(values, 0.95)),
    p99: round3(quantile(values, 0.99)),
    p999: round3(quantile(values, 0.999)),
    max: round3(values[values.length - 1]),
  };
}

function metricValues(metrics, name) {
  const metric = metrics[name];
  return metric && metric.values ? metric.values : null;
}

function pickNumber(values, keys) {
  if (!values) return null;
  for (const key of keys) {
    if (typeof values[key] === 'number' && Number.isFinite(values[key])) return values[key];
  }
  return null;
}

function statsFromSummary(metrics, name) {
  const values = metricValues(metrics, name);
  if (!values) return null;
  return {
    count: pickNumber(values, ['count']) || 0,
    min: round3(pickNumber(values, ['min'])),
    avg: round3(pickNumber(values, ['avg'])),
    p50: round3(pickNumber(values, ['p(50)', 'med'])),
    p90: round3(pickNumber(values, ['p(90)'])),
    p95: round3(pickNumber(values, ['p(95)'])),
    p99: round3(pickNumber(values, ['p(99)'])),
    p999: round3(pickNumber(values, ['p(99.9)'])),
    max: round3(pickNumber(values, ['max'])),
  };
}

function collectThresholds(metrics) {
  const results = {};
  const failed = [];
  for (const [name, metric] of Object.entries(metrics)) {
    if (!metric || !metric.thresholds) continue;
    results[name] = {};
    for (const [expr, info] of Object.entries(metric.thresholds)) {
      const ok = Boolean(info && info.ok === true);
      results[name][expr] = ok;
      if (!ok) failed.push(`${name} ${expr}`);
    }
  }
  return { results, failed };
}

function parseArgsOrDie() {
  return parseArgs(process.argv.slice(2));
}

async function readJson(path, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    die(`${label} is not readable JSON (${path}): ${error.message}`);
  }
}

async function parseRaw(path, state) {
  const rl = createInterface({
    input: createReadStream(path, 'utf8'),
    crlfDelay: Infinity,
  });
  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    const text = line.trim();
    if (!text) continue;
    let record;
    try {
      record = JSON.parse(text);
    } catch {
      state.malformedLines++;
      if (state.malformedFirst.length < 5) state.malformedFirst.push(lineNo);
      continue;
    }
    if (!record || typeof record !== 'object') continue;

    if (record.type === 'Metric') {
      const name = record.data && record.data.name;
      if (name) state.metricDefs.add(name);
      continue;
    }
    if (record.type !== 'Point' || !record.data) continue;
    const value = record.data.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    const name = record.metric;
    if (!name) continue;
    state.metricDefs.add(name);
    state.points++;

    const tags = record.data.tags || {};
    const at = Date.parse(record.data.time);
    if (Number.isFinite(at)) {
      if (state.anyFirst === null || at < state.anyFirst) state.anyFirst = at;
      if (state.anyLast === null || at > state.anyLast) state.anyLast = at;
    }

    if (name === 'http_req_duration') {
      const phase = tags.phase || 'untagged';
      const op = tags.op || 'untagged';
      const status = tags.status === undefined ? 'missing' : String(tags.status);
      state.requests++;
      state.all.push(value);
      ensure(state.phases, phase).push(value);
      ensure(state.ops, op).push(value);
      inc(state.status, status);
      const opState = ensureOp(state, op);
      inc(opState.status, status);
      if (Number.isFinite(at)) {
        if (state.httpFirst === null || at < state.httpFirst) state.httpFirst = at;
        if (state.httpLast === null || at > state.httpLast) state.httpLast = at;
        notePhaseTime(state, phase, at);
      }
      continue;
    }

    if (name === 'http_req_failed') {
      state.failedPoints++;
      if (value > 0) {
        state.httpReqFailed++;
        inc(state.httpReqFailedByOp, tags.op || 'missing');
        inc(state.httpReqFailedByPhase, tags.phase || 'missing');
        inc(state.httpReqFailedByStatus, tags.status === undefined ? 'missing' : String(tags.status));
      }
      continue;
    }

    if (name === 'c0_request_failed') {
      state.requestFailedPoints++;
      if (value > 0) state.requestFailed++;
      continue;
    }

    if (name === 'c0_http_failures') {
      state.customFailurePoints++;
      const op = tags.op || 'missing';
      const phase = tags.phase || 'missing';
      const status = tags.status === undefined ? 'missing' : String(tags.status);
      const code = tags.code || 'missing';
      const feature = tags.feature || 'missing';
      state.failures.total++;
      inc(state.failures.byStatus, status);
      inc(state.failures.byCode, code);
      inc(state.failures.byFeature, feature);
      inc(state.failures.byOp, op);
      inc(state.failures.byPhase, phase);
      if (!state.failures.byOpDetail[op]) {
        state.failures.byOpDetail[op] = {
          total: 0,
          byStatus: {},
          byCode: {},
          byFeature: {},
        };
      }
      const detail = state.failures.byOpDetail[op];
      detail.total++;
      inc(detail.byStatus, status);
      inc(detail.byCode, code);
      inc(detail.byFeature, feature);
      continue;
    }

    if (name === 'c0_x_teable_v2') {
      state.v2Points++;
      const op = tags.op || 'missing';
      const bucket = normalizeV2(tags.value);
      state.v2.total[bucket]++;
      state.v2.byOp[op] = state.v2.byOp[op] || zeroV2Buckets();
      state.v2.byOp[op][bucket]++;
    }
  }
  if (state.malformedLines > 0) {
    state.warnings.push(
      `raw file has ${state.malformedLines} malformed line(s) at ${state.malformedFirst.join(', ')}`
    );
  }
}

function ensure(map, key) {
  if (!map[key]) map[key] = [];
  return map[key];
}

function ensureOp(state, op) {
  if (!state.opsState[op]) {
    state.opsState[op] = { status: {}, failures: null };
  }
  return state.opsState[op];
}

function notePhaseTime(state, phase, at) {
  if (!state.phaseTimes[phase]) state.phaseTimes[phase] = { first: null, last: null };
  const info = state.phaseTimes[phase];
  if (info.first === null || at < info.first) info.first = at;
  if (info.last === null || at > info.last) info.last = at;
}

function makeRawState() {
  return {
    points: 0,
    requests: 0,
    all: [],
    phases: {},
    ops: {},
    opsState: {},
    status: {},
    failedPoints: 0,
    httpReqFailed: 0,
    httpReqFailedByOp: {},
    httpReqFailedByPhase: {},
    httpReqFailedByStatus: {},
    requestFailedPoints: 0,
    requestFailed: 0,
    customFailurePoints: 0,
    failures: {
      total: 0,
      byStatus: {},
      byCode: {},
      byFeature: {},
      byOp: {},
      byPhase: {},
      byOpDetail: {},
    },
    v2Points: 0,
    v2: { total: zeroV2Buckets(), byOp: {} },
    metricDefs: new Set(),
    malformedLines: 0,
    malformedFirst: [],
    anyFirst: null,
    anyLast: null,
    httpFirst: null,
    httpLast: null,
    phaseTimes: {},
    warnings: [],
  };
}

function summarizeRaw(state) {
  const duration = stats(state.all);
  const phases = {};
  for (const phase of EXPECTED_PHASES) {
    const times = state.phaseTimes[phase] || null;
    phases[phase] = {
      ...stats(state.phases[phase] || []),
      observedStart: times ? new Date(times.first).toISOString() : null,
      observedEnd: times ? new Date(times.last).toISOString() : null,
      observedSec:
        times && times.last !== null ? round3((times.last - times.first) / 1000) : null,
    };
  }
  if (state.phases.untagged) {
    phases.untagged = stats(state.phases.untagged);
  }

  const ops = {};
  for (const op of EXPECTED_OPS) {
    const opStats = stats(state.ops[op] || []);
    const opState = state.opsState[op] || { status: {}, failures: null };
    ops[op] = {
      present: opStats.count > 0,
      requests: opStats.count,
      duration: opStats,
      status: sortObject(opState.status),
      xTeableV2: v2ForOp(state, op),
      failures: state.failures.byOpDetail[op] || {
        total: 0,
        byStatus: {},
        byCode: {},
        byFeature: {},
      },
    };
  }
  for (const op of Object.keys(state.ops)) {
    if (!EXPECTED_OPS.includes(op)) {
      ops[op] = {
        present: true,
        requests: state.ops[op].length,
        duration: stats(state.ops[op]),
        status: state.opsState[op] ? sortObject(state.opsState[op].status) : {},
        xTeableV2: v2ForOp(state, op),
        failures: state.failures.byOpDetail[op] || {
          total: 0,
          byStatus: {},
          byCode: {},
          byFeature: {},
        },
        unexpectedOp: true,
      };
    }
  }

  const failureSource =
    state.customFailurePoints > 0 || state.metricDefs.has('c0_http_failures')
      ? 'c0_http_failures'
      : state.failedPoints > 0
        ? 'http_req_failed_tags'
        : 'c0_http_failures';
  const failures =
    failureSource === 'http_req_failed_tags'
      ? {
          total: state.httpReqFailed,
          byStatus: sortObject(state.httpReqFailedByStatus),
          byCode: {},
          byFeature: {},
          byOp: sortObject(state.httpReqFailedByOp),
          byPhase: sortObject(state.httpReqFailedByPhase),
          byOpDetail: state.failures.byOpDetail,
        }
      : {
          total: state.failures.total,
          byStatus: sortObject(state.failures.byStatus),
          byCode: sortObject(state.failures.byCode),
          byFeature: sortObject(state.failures.byFeature),
          byOp: sortObject(state.failures.byOp),
          byPhase: sortObject(state.failures.byPhase),
          byOpDetail: state.failures.byOpDetail,
        };


  if (state.v2Points > 0) {
    const v2Sum =
      state.v2.total.true +
      state.v2.total.false +
      state.v2.total.missing +
      state.v2.total.other;
    if (state.requests > 0 && v2Sum !== state.requests) {
      state.warnings.push(
        `x-teable-v2 samples (${v2Sum}) do not match requests (${state.requests})`
      );
    }
    for (const op of EXPECTED_OPS) {
      const opRequests = state.ops[op] ? state.ops[op].length : 0;
      const buckets = state.v2.byOp[op];
      if (!buckets) {
        if (opRequests > 0) state.warnings.push(`no x-teable-v2 samples for op ${op}`);
        continue;
      }
      const sum = buckets.true + buckets.false + buckets.missing + buckets.other;
      if (opRequests > 0 && sum !== opRequests) {
        state.warnings.push(
          `x-teable-v2 samples for op ${op} (${sum}) do not match requests (${opRequests})`
        );
      }
    }
  }
  if (state.requestFailedPoints > 0 && state.requestFailedPoints !== state.requests) {
    state.warnings.push(
      `c0_request_failed samples (${state.requestFailedPoints}) do not match requests (${state.requests})`
    );
  }
  if (state.failedPoints > 0 && state.failedPoints !== state.requests) {
    state.warnings.push(
      `http_req_failed samples (${state.failedPoints}) do not match requests (${state.requests})`
    );
  }
  if (
    state.customFailurePoints > 0 &&
    state.httpReqFailed > 0 &&
    state.customFailurePoints !== state.httpReqFailed
  ) {
    state.warnings.push(
      `c0_http_failures (${state.customFailurePoints}) and http_req_failed (${state.httpReqFailed}) disagree`
    );
  }
  return {
    requests: state.requests,
    duration,
    phases,
    ops,
    status: sortObject(state.status),
    failedCount:
      state.requestFailedPoints > 0 ? state.requestFailed : state.httpReqFailed,
    errorMetric:
      state.requestFailedPoints > 0 ? 'c0_request_failed' : 'http_req_failed',
    httpReqFailed: state.httpReqFailed,
    failures,
    failureSource,
    v2: {
      source: state.v2Points > 0 ? 'raw' : 'missing',
      total: state.v2.total,
      byOp: Object.fromEntries(
        [...new Set([...EXPECTED_OPS, ...Object.keys(state.v2.byOp)])].map((op) => [
          op,
          v2ForOp(state, op),
        ])
      ),
    },
    firstAt: state.httpFirst !== null ? state.httpFirst : state.anyFirst,
    lastAt: state.httpLast !== null ? state.httpLast : state.anyLast,
    warnings: state.warnings,
    metricDefs: state.metricDefs,
  };
}

function summaryOpStats(metrics, op) {
  return (
    statsFromSummary(metrics, `teable_op_duration{op:${op}}`) ||
    statsFromSummary(metrics, `http_req_duration{op:${op}}`)
  );
}

function buildSummaryFallback(metrics) {
  const requests = pickNumber(metricValues(metrics, 'http_reqs'), ['count']);
  const duration = statsFromSummary(metrics, 'http_req_duration');
  const failedRateC0 = pickNumber(metricValues(metrics, 'c0_request_failed'), ['rate']);
  const failedRateHttp = pickNumber(metricValues(metrics, 'http_req_failed'), ['rate']);
  const failedRate =
    failedRateC0 !== null ? failedRateC0 : failedRateHttp !== null ? failedRateHttp : null;
  const failedCount =
    failedRate !== null && requests !== null ? Math.round(failedRate * requests) : null;

  const phases = {};
  for (const phase of ['warm', 'ramp', 'plateau', 'drain']) {
    phases[phase] = statsFromSummary(metrics, `http_req_duration{phase:${phase}}`);
  }

  const ops = {};
  for (const op of EXPECTED_OPS) {
    const s = summaryOpStats(metrics, op);
    ops[op] = {
      present: Boolean(
        s && (s.count > 0 || s.p50 !== null || s.p95 !== null || s.p99 !== null || s.max !== null)
      ),
      requests: s ? s.count : 0,
      duration: s,
      status: null,
      xTeableV2: null,
      failures: null,
    };
  }

  const v2Total = zeroV2Buckets();
  let v2Any = false;
  for (const bucket of ['true', 'false', 'missing', 'other']) {
    const values = metricValues(metrics, `c0_x_teable_v2{value:${bucket}}`);
    const count = pickNumber(values, ['count']);
    if (count !== null) {
      v2Total[bucket] = count;
      v2Any = true;
    }
  }

  return {
    requests,
    rate: pickNumber(metricValues(metrics, 'http_reqs'), ['rate']),
    duration,
    phases,
    ops,
    failedRate,
    failedCount,
    failedRateC0,
    failedRateHttp,
    errorMetric:
      failedRateC0 !== null ? 'c0_request_failed' : failedRateHttp !== null ? 'http_req_failed' : null,
    droppedIterations: pickNumber(metricValues(metrics, 'dropped_iterations'), ['count']),
    vusMax: pickNumber(metricValues(metrics, 'vus_max'), ['max', 'value']),
    dataReceived: pickNumber(metricValues(metrics, 'data_received'), ['count']),
    iterationDuration: metricValues(metrics, 'iteration_duration'),
    v2Total: v2Any ? v2Total : null,
    thresholds: collectThresholds(metrics),

  };
}

function mergeGuardrails(rawSummary, fallback, meta, minSamples) {
  const raw = rawSummary;
  const requests =
    raw && raw.requests > 0 ? raw.requests : fallback.requests !== null ? fallback.requests : 0;
  const failedCount =
    raw && raw.requests > 0
      ? raw.failedCount
      : fallback.failedCount !== null
        ? fallback.failedCount
        : null;
  const errorRate =
    failedCount !== null && requests > 0 ? failedCount / requests : fallback.failedRate;
  const p99 =
    raw && raw.duration.count > 0 ? raw.duration.p99 : fallback.duration ? fallback.duration.p99 : null;
  const plateauDuration =
    raw && raw.phases.plateau && raw.phases.plateau.count > 0
      ? raw.phases.plateau
      : fallback.phases.plateau;
  const plateauP95 = plateauDuration ? plateauDuration.p95 : null;
  const plateauRequests = plateauDuration ? plateauDuration.count : 0;
  const errorsEvaluable = errorRate !== null && requests >= minSamples;
  const p99Evaluable = p99 !== null && requests >= minSamples;
  const plateauEvaluable = plateauP95 !== null && plateauRequests >= minSamples;

  const errorBreach = errorsEvaluable ? errorRate > ERROR_RATE_MAX : null;
  const p99Breach = p99Evaluable ? p99 > P99_MAX_MS : null;
  const plateauBreach = plateauEvaluable ? plateauP95 > PLATEAU_P95_MAX_MS : null;

  const sources = {
    errorRate: raw && raw.requests > 0 ? 'raw' : fallback.failedRate !== null ? 'summary' : 'missing',
    p99: raw && raw.duration.count > 0 ? 'raw' : fallback.duration ? 'summary' : 'missing',
    plateauP95:
      raw && raw.phases.plateau && raw.phases.plateau.count > 0
        ? 'raw'
        : fallback.phases.plateau
          ? 'summary'
          : 'missing',
  };

  const evaluable = {
    errors: errorsEvaluable,
    p99: p99Evaluable,
    plateauP95: plateauEvaluable,
  };
  const breach = {
    errors: errorBreach,
    p99: p99Breach,
    plateauP95: plateauBreach,
  };
  let status = 'inconclusive';
  if (errorBreach === true || p99Breach === true || plateauBreach === true) status = 'breach';
  else if (errorBreach === false && p99Breach === false && plateauBreach === false) status = 'pass';

  return {
    minSamples,
    sample: { requests, plateauRequests },
    errorRate: {
      value: round3(errorRate),
      max: ERROR_RATE_MAX,
      breach: errorBreach,
      evaluable: errorsEvaluable,
      source: sources.errorRate,
      metric: raw && raw.requests > 0 ? raw.errorMetric : fallback.errorMetric,
    },
    p99: {
      value: round3(p99),
      maxMs: P99_MAX_MS,
      breach: p99Breach,
      evaluable: p99Evaluable,
      source: sources.p99,
    },
    plateauP95: {
      value: round3(plateauP95),
      maxMs: PLATEAU_P95_MAX_MS,
      breach: plateauBreach,
      evaluable: plateauEvaluable,
      source: sources.plateauP95,
      observedSec: raw && raw.phases.plateau ? raw.phases.plateau.observedSec : null,
      plannedSec: meta && meta.phases ? meta.phases.plateauSec : null,
    },
    status,
    note:
      'A guardrail is only evaluated after minSamples; below that it is null (inconclusive), not pass.',
  };
}

async function main() {
  const opts = parseArgsOrDie();
  const summaryPath = resolve(opts.summary);
  if (!existsSync(summaryPath)) die(`summary file not found: ${summaryPath}`, 2);

  const summary = await readJson(summaryPath, 'summary');
  if (!summary || typeof summary !== 'object') die('summary must be a JSON object', 2);
  if (!summary.metrics || typeof summary.metrics !== 'object') {
    if (summary.http || summary.http_req_duration) {
      die(
        'input looks like compact k6-summary output, not a raw k6 summary; pass the k6 handleSummary/--summary-export file',
        2
      );
    }
    die('summary has no metrics object', 2);
  }
  const metrics = summary.metrics;
  const warnings = [];

  const metaPath = opts.meta ? resolve(opts.meta) : metaPathFor(summaryPath);
  let meta = null;
  let metaFound = false;
  if (existsSync(metaPath)) {
    meta = await readJson(metaPath, 'run metadata');
    metaFound = true;
  } else if (opts.meta) {
    die(`run metadata file not found: ${metaPath}`, 2);
  } else {
    warnings.push(`run metadata missing: ${metaPath}`);
  }

  let rawPath = opts.raw ? resolve(opts.raw) : '';
  let rawAuto = false;
  if (!rawPath && meta && meta.rawOutput && meta.rawOutput.path) {
    const candidate = resolve(meta.rawOutput.path);
    if (existsSync(candidate)) {
      rawPath = candidate;
      rawAuto = true;
    } else {
      warnings.push(`raw NDJSON recorded in metadata is not present: ${candidate}`);
    }
  }
  if (opts.raw && !existsSync(rawPath)) die(`raw NDJSON not found: ${rawPath}`, 2);

  let raw = null;
  if (rawPath) {
    const state = makeRawState();
    await parseRaw(rawPath, state);
    raw = summarizeRaw(state);
    for (const warning of raw.warnings) warnings.push(warning);
  }

  const fallback = buildSummaryFallback(metrics);
  const guardrails = mergeGuardrails(raw, fallback, meta, opts.minSamples);

  const missing = [];
  const coreMissing = [];

  function missingCore(entry) {
    missing.push(entry);
    coreMissing.push(entry);
  }
  function missingSoft(entry) {
    missing.push(entry);
  }

  if (fallback.requests === null && (!raw || raw.requests === 0)) {
    missingCore('http_reqs.count');
  }
  if (!fallback.duration && (!raw || raw.duration.count === 0)) {
    missingCore('http_req_duration');
  }
  if (fallback.failedRate === null && (!raw || raw.requests === 0)) {
    missingCore('http_req_failed.rate');
  }
  if (guardrails.p99.value === null) missingCore('http_req_duration.p99');
  if (guardrails.plateauP95.value === null) missingCore('http_req_duration{phase:plateau}.p95');
  if (!raw) {
    missingCore('raw.ndjson (required for exact phase/op quantiles and per-op x-teable-v2)');
    missingCore('x_teable_v2.per_operation');
  }
  if (raw && raw.failureSource === 'http_req_failed_tags' && raw.failures.total > 0) {
    missingCore('failures.by_code (c0_http_failures samples absent)');
    missingCore('failures.by_feature (c0_http_failures samples absent)');
  }
  if (raw && raw.v2.source === 'missing' && raw.requests > 0) {
    missingCore('x_teable_v2.per_operation (c0_x_teable_v2 samples absent)');
  }
  if (!raw && fallback.failedCount !== null && fallback.failedCount > 0) {
    missingCore('failures.by_code (raw NDJSON required)');
    missingCore('failures.by_feature (raw NDJSON required)');
  }

  for (const op of EXPECTED_OPS) {
    const opEntry = raw && raw.ops[op] ? raw.ops[op] : fallback.ops[op];
    const present = Boolean(
      opEntry &&
        (opEntry.present ||
          (opEntry.duration &&
            (opEntry.duration.count > 0 ||
              opEntry.duration.p95 !== null ||
              opEntry.duration.p99 !== null)))
    );
    if (!present) missingCore(`ops.${op}`);
    else if (!raw) missingCore(`ops.${op}.status (raw NDJSON required)`);
  }
  for (const phase of ['warm', 'ramp']) {
    const p = raw ? raw.phases[phase] : fallback.phases[phase];
    if (!p || p.count === 0) missingSoft(`http_req_duration{phase:${phase}}`);
  }

  let startedAt = null;
  let endedAt = null;
  let timeSource = 'missing';
  if (raw && raw.firstAt !== null) {
    startedAt = new Date(raw.firstAt).toISOString();
    endedAt = new Date(raw.lastAt).toISOString();
    timeSource = 'raw-first-last-request';
  } else if (meta && meta.window && meta.window.startedAt && meta.window.endedAt) {
    startedAt = meta.window.startedAt;
    endedAt = meta.window.endedAt;
    timeSource = 'run-metadata';
  } else if (typeof summary.state?.testRunDurationMs === 'number') {
    timeSource = 'summary-duration-only';
    missingSoft('time.startedAt');
    missingSoft('time.endedAt');
  } else {
    missingSoft('time.startedAt');
    missingSoft('time.endedAt');
  }

  const droppedIterations =
    fallback.droppedIterations !== null ? fallback.droppedIterations : null;
  if (droppedIterations === null) missingSoft('dropped_iterations');

  if (meta && meta.take && meta.take.capped) {
    warnings.push(`TAKE requested ${meta.take.requested}, capped at ${meta.take.used}`);
  }
  if (meta && meta.warmFraction !== undefined && Math.abs(meta.warmFraction - 0.5) > 0.001) {
    warnings.push(
      `warm rate is ${meta.warmRate}/${meta.targetRps} = ${meta.warmFraction} (integer rate cannot be exactly 50%)`
    );
  }
  if (meta && meta.window && meta.window.endedEarly) {
    warnings.push('run ended before the planned warm+ramp+plateau duration');
  }
  if (raw && fallback.requests !== null && raw.requests !== fallback.requests) {
    warnings.push(
      `request count differs between raw (${raw.requests}) and summary (${fallback.requests})`
    );
  }
  if (
    raw &&
    raw.failedCount !== null &&
    fallback.failedCount !== null &&
    raw.failedCount !== fallback.failedCount
  ) {
    warnings.push(
      `failed count differs between raw (${raw.failedCount}) and summary (${fallback.failedCount})`
    );
  }
  if (
    raw &&
    raw.failureSource === 'http_req_failed_tags' &&
    raw.failures.total > 0
  ) {
    warnings.push('c0_http_failures missing; failure codes/features unavailable');
  }

  const runId = (meta && meta.runId) || process.env.RUN_ID || null;
  const step = (meta && meta.step) || process.env.STEP_NAME || null;
  const targetRps =
    (meta && meta.targetRps) || (Number(process.env.STEP_TARGET || 0) || null);

  const phasesOut = {};
  for (const phase of ['warm', 'ramp', 'plateau', 'drain']) {
    const fromRaw = raw ? raw.phases[phase] : null;
    const fromSummary = fallback.phases[phase];
    const chosen = fromRaw && fromRaw.count > 0 ? fromRaw : fromSummary;
    phasesOut[phase] = {
      ...(chosen || {
        count: 0,
        min: null,
        avg: null,
        p50: null,
        p90: null,
        p95: null,
        p99: null,
        p999: null,
        max: null,
      }),
      source: fromRaw && fromRaw.count > 0 ? 'raw' : fromSummary ? 'summary' : 'missing',
    };
  }

  const opsOut = {};
  for (const op of EXPECTED_OPS) {
    const rawOp = raw ? raw.ops[op] : null;
    const sumOp = fallback.ops[op];
    if (rawOp && rawOp.present) {
      opsOut[op] = {
        present: true,
        requests: rawOp.requests,
        duration: rawOp.duration,
        status: rawOp.status,
        xTeableV2: rawOp.xTeableV2,
        failures: {
          total: rawOp.failures.total,
          byStatus: sortObject(rawOp.failures.byStatus),
          byCode: sortObject(rawOp.failures.byCode),
          byFeature: sortObject(rawOp.failures.byFeature),
        },
        source: 'raw',
      };
    } else if (sumOp) {
      opsOut[op] = {
        present: sumOp.present,
        requests: sumOp.requests,
        duration: sumOp.duration,
        status: sumOp.status,
        xTeableV2: sumOp.xTeableV2,
        failures: sumOp.failures,
        source: 'summary',
      };
    } else {
      opsOut[op] = { present: false, requests: 0, source: 'missing' };
    }
  }

  if (raw) {
    for (const op of Object.keys(raw.ops)) {
      if (EXPECTED_OPS.includes(op)) continue;
      const unexpected = raw.ops[op];
      opsOut[op] = {
        present: unexpected.present,
        requests: unexpected.requests,
        duration: unexpected.duration,
        status: unexpected.status,
        xTeableV2: unexpected.xTeableV2,
        failures: unexpected.failures,
        source: 'raw',
        unexpectedOp: true,
      };
    }
  }

  const failureOut = raw
    ? {
        source: raw.failureSource,
        total: raw.failures.total,
        byStatus: raw.failures.byStatus,
        byCode: raw.failures.byCode,
        byFeature: raw.failures.byFeature,
        byOp: raw.failures.byOp,
        byPhase: raw.failures.byPhase,
      }
    : {
        source: 'summary_only',
        total: fallback.failedCount,
        byStatus: null,
        byCode: null,
        byFeature: null,
        byOp: null,
        byPhase: null,
      };

  const v2Out = raw
    ? {
        source: raw.v2.source,
        total: raw.v2.total,
        byOp: raw.v2.byOp,
      }
    : {
        source: fallback.v2Total ? 'summary' : 'missing',
        total: fallback.v2Total,
        byOp: null,
      };

  const allDuration = raw && raw.duration.count > 0 ? raw.duration : fallback.duration;
  const requests = raw && raw.requests > 0 ? raw.requests : fallback.requests;
  const failedRate =
    raw && raw.requests > 0
      ? round3(raw.failedCount / raw.requests)
      : fallback.failedRate !== null
        ? round3(fallback.failedRate)
        : null;
  const failedCount =
    raw && raw.requests > 0 ? raw.failedCount : fallback.failedCount;

  const observed = raw && raw.firstAt !== null ? (raw.lastAt - raw.firstAt) / 1000 : null;

  const thresholds = fallback.thresholds;
  const report = {
    schema: SCHEMA,
    runId,
    step,
    targetRps,
    sources: {
      summary: summaryPath,
      meta: metaFound ? metaPath : null,
      raw: rawPath || null,
      rawAutoDetected: rawAuto,
      quantileMethod: 'linear interpolation on sorted raw samples, position q*(n-1)',
    },
    time: {
      startedAt,
      endedAt,
      source: timeSource,
      observedDurationSec: observed !== null ? round3(observed) : null,
      plannedDurationSec: meta && meta.phases ? meta.phases.totalSec : null,
      phases: meta && meta.phases ? meta.phases : null,
      plateauWindow: meta && meta.window
        ? {
            startedAt: meta.window.plateauStart,
            endedAt: meta.window.plateauEnd,
          }
        : null,
    },
    http: {
      requests,
      rate: fallback.rate,
      observedRate: observed && observed > 0 ? round3(requests / observed) : null,
      failedRate,
      failedCount,
      errorMetric: raw && raw.requests > 0 ? raw.errorMetric : fallback.errorMetric,
      httpReqFailedRate:
        raw && raw.requests > 0
          ? round3(raw.httpReqFailed / raw.requests)
          : fallback.failedRateHttp !== null
            ? round3(fallback.failedRateHttp)
            : null,
      droppedIterations,
      vusMax: fallback.vusMax,
      dataReceived: fallback.dataReceived,
    },
    http_req_duration: allDuration || {
      count: 0,
      min: null,
      avg: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
      p999: null,
      max: null,
    },
    iteration_duration: fallback.iterationDuration || null,
    phases: phasesOut,
    ops: opsOut,
    status: raw ? raw.status : null,
    failures: failureOut,
    xTeableV2: v2Out,
    guardrails,
    thresholds: thresholds.results,
    thresholdsFailed: thresholds.failed,
    missing,
    coreMissing,
    warnings,
    meta: meta
      ? {
          warmRate: meta.warmRate,
          warmFraction: meta.warmFraction,
          take: meta.take,
          ids: meta.ids,
          vus: meta.vus,
          guardrails: meta.guardrails,
          thresholdsFailed: meta.thresholdsFailed,
          rawOutput: meta.rawOutput,
        }
      : null,
  };


  const json = JSON.stringify(report, null, 2);
  if (opts.out) {
    try {
      await writeFile(opts.out, json + '\n', 'utf8');
    } catch (error) {
      die(`cannot write --out file (${opts.out}): ${error.message}`, 2);
    }
  }
  console.log(json);

  if (coreMissing.length > 0 || (raw && raw.warnings.length > 0)) {
    process.exitCode = 1;
  } else if (opts.strict && missing.length > 0) {
    process.exitCode = 1;
  } else if (opts.failOnBreach && guardrails.status === 'breach') {
    process.exitCode = 3;
  }
}

main().catch((error) => {
  die(`unhandled error: ${error && error.message ? error.message : String(error)}`, 1);
});
