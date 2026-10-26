// C0 modal BYODB breakpoint step: open-model arrival, C0 mix
// read 50 (list 40 / get 10) / write 30 (create 15 / update 15) / computed 20.
//
// One invocation is ONE breakpoint step. The stages are exact, not rounded to
// whole minutes:
//   warmupSec  constant at 50% of STEP_TARGET (startRate == first stage target)
//   rampSec    linear 50% -> 100% of STEP_TARGET
//   plateauSec constant at STEP_TARGET          <- measurement window
//
// Defaults are the C0 contract (10m / 10m / 30m). For a smoke gate set the
// seconds directly, e.g. STEP_WARMUP_SEC=60 STEP_RAMP_SEC=60 STEP_PLATEAU_SEC=60.
//
// Env (required): BASE_URL, TOKEN, TABLE_ID, RECORD_IDS_FILE, RUN_ID, STEP_NAME,
//                 STEP_TARGET (e.g. 12.5 / 25 / 75 / 150, fractional allowed)
// Env (optional): STEP_WARMUP_SEC (600), STEP_RAMP_SEC (600), STEP_PLATEAU_SEC (1800),
//                 legacy STEP_WARMUP_MIN / STEP_RAMP_MIN / STEP_PLATEAU_MIN (used only
//                 when the corresponding *_SEC is unset; fractional minutes allowed),
//                 TAKE (50, hard-capped at 100), SUMMARY_PATH (summary-c0.json),
//                 RAW_OUT (path passed to `k6 run --out json=<path>`; recorded in meta),
//                 PRE_VUS, MAX_VUS, GUARDRAIL_DELAY_SEC (default = STEP_WARMUP_SEC),
//                 SUPERVISOR_WINDOW_SEC (60), SUPERVISOR_GRACE_SEC (5),
//                 GUARDRAIL_DROPPED_PCT (5),
//                 TYPECAST (false), COMPUTED_WORKER_PRESENT (unset => null/unknown),
//                 RUN_STARTED_EPOCH_MS (optional declared window start, ms),
//                 APP_DB_RTT_PROBE_PATH / APP_DB_RTT_PROBE_SAMPLES (opt-in, see below)
// Env (C0 v2 profile, default OFF): V2_HOT_ROW_PCT, V2_HOT_RECORD_ID,
//                 V2_CROSS_TABLE_PCT, V2_CROSS_TABLE_ID, V2_CROSS_TABLE_RECORD_ID,
//                 V2_CROSS_TABLE_FIELD
// Env (local verification only): DEBUG_FAIL_RATE (loopback BASE_URL only)
//
// STEP_TARGET fractional math: k6 arrival-rate executors only accept integer
// rates per timeUnit, so the unit is widened to the smallest integral unit that
// makes BOTH the target and its 50% warm rate integral. 12.5 rps resolves to
// 50 arrivals / 4s with a 25-per-4s warm phase (2s would need a 12.5 warm rate).
// The resolved numbers are recorded in meta.arrival.
//
// Outputs:
//   SUMMARY_PATH             raw k6 summary data (unmodified `data` object)
//   SUMMARY_PATH.run.json    run metadata: window/bucket grid, resolved config,
//                            per-operation results, supervisor decisions,
//                            threshold results, sampling contract, raw-output path
//
// SUPERVISION (why the test stopped) — per bucket, not cumulative:
//   The whole-run error rate and P99 are only reported. A 1-minute burst barely
//   moves a cumulative rate, so abort decisions are made on per-bucket
//   submetrics (default bucket = 60s):
//     c0_request_failed{bucket:B###}      rate <= 1%        abort
//     http_req_duration{bucket:B###}      p(99) <= 2000ms   abort
//     dropped_iterations                  count <= budget   abort
//   The drop guardrail uses k6's own cumulative dropped_iterations counter with
//   one cumulative budget per supervised bucket: count <= floor(5% of the
//   arrivals planned up to that bucket). A cumulative COUNT threshold reacts as
//   soon as drops happen (a cumulative rate does not), only its activation time
//   is bucketed, and it passes with zero samples, so a bucket that never ran
//   cannot produce a phantom breach. Budgets are non-decreasing, so the newest
//   active one is always the binding one.
//   Each bucket threshold carries delayAbortEval = bucket end + grace, so the
//   error/P99 decisions are only evaluated once that bucket is complete (no
//   partial-minute false positives) and never again afterwards. k6 evaluates
//   thresholds about every 2s, so a breach aborts within ~2s of the deadline.
//   Every decision is written to meta.supervisor, including the first breached
//   bucket, the observed value and the evaluation deadline, so evidence can show
//   WHY the step stopped. Cumulative error/P99 thresholds stay for reporting and
//   never abort.
//   Buckets whose evaluation deadline falls after the planned end of the run
//   (and buckets before GUARDRAIL_DELAY_SEC) are reported but not supervised.
//   meta.droppedIterations.byBucket also carries the exact per-bucket arrival
//   deficit (planned integral minus c0_iterations_started{bucket}).
//
// Optional SLO kept from C0: plateau-only http_req_duration p(95) <= 1000ms,
// evaluated end-of-test (no abort) so a plateau miss is not confused with the
// per-bucket P99 abort.
//
// Exact plateau/per-bucket/per-op quantiles and failure/v2 breakdowns are also
// computed from the raw `--out json=<RAW_OUT>` NDJSON by
// stress-tests/tools/k6-summary.mjs. Keep that file with the summary; it is the
// source of truth for slicing that is not materialised here.
//
// SAMPLING CONTRACT (ingress / meta plane / app pool):
//   k6 never reads the cluster. External samplers join on the bucket grid that
//   this script records in meta.sampling.buckets (tag, startEpochMs, endEpochMs,
//   phase) and on the request tags it emits:
//     baggage: teable.loadtest.run_id / scenario / phase / step / bucket / api
//     header:  x-c0-bucket: B###   (bounded: <= SUPERVISOR_WINDOW_SEC buckets)
//   The sampler side must consume these documented env values, which mirror the
//   meta fields 1:1 (the driver exports them before starting k6 and the sampler):
//     C0_RUN_ID                  = RUN_ID
//     C0_STEP_NAME               = STEP_NAME
//     C0_WINDOW_FILE             = SUMMARY_PATH.run.json (written at test end)
//     C0_BUCKET_SEC              = SUPERVISOR_WINDOW_SEC
//     C0_STEP_START_EPOCH_MS     = meta.window.startedAtEpochMs
//     C0_STEP_END_EPOCH_MS       = meta.window.endedAtEpochMs
//     C0_PLATEAU_START_EPOCH_MS  = meta.window.plateauStartEpochMs
//     C0_PLATEAU_END_EPOCH_MS    = meta.window.plateauEndEpochMs
//     C0_PHASE                   = warm|ramp|plateau (label the sampler stamps)
//   Pass RUN_STARTED_EPOCH_MS to k6 as well so the sampler can align its clock
//   grid to the same instant while the run is still going; k6 records the
//   difference between the declared and actual start in
//   meta.window.declaredDeltaMs. Missing samples must be recorded as null,
//   never as zero.
//
// APP_DB_RTT_ms CONTRACT:
//   k6 can only measure a full client -> app -> DB -> app -> client round trip,
//   and only from outside the measured window (setup), so this is opt-in:
//     APP_DB_RTT_PROBE_PATH   e.g. /api/health/db, an endpoint whose handler
//                             performs exactly one trivial DB read (SELECT 1)
//     APP_DB_RTT_PROBE_SAMPLES  default 5, capped at 20
//   The result is emitted as the c0_app_db_rtt_ms trend and summarised in
//   meta.appDbRttMs {enabled, path, valueMs, minMs, maxMs, samples,
//   includesClientToAppMs, source, externalProbe, note}; valueMs is the median
//   of the samples. Probe requests are tagged phase:setup and are outside the
//   warm/ramp/plateau submetrics.
//   If the path is unset, meta.appDbRttMs.enabled is false and valueMs is null:
//   the evidence writer MUST store App_DB_RTT_ms as null, never 0. The
//   app-internal component can only come from an external probe (documented in
//   the evidence contract, e.g. a `SELECT 1` timing taken on the app host or the
//   DB-side sampler), because k6 cannot see inside that hop.
//
// C0 v2 PROFILE (default OFF, today's numbers stay comparable):
//   V2_HOT_ROW_PCT=30          redirect that share of update+computed writes to
//                              one hot record (V2_HOT_RECORD_ID, else ids[0])
//   V2_CROSS_TABLE_PCT=30      redirect that share of computed writes to a
//                              record in V2_CROSS_TABLE_ID (requires
//                              V2_CROSS_TABLE_RECORD_ID, field
//                              V2_CROSS_TABLE_FIELD, default Qty) so the
//                              recompute traverses the cross-table lookup
//   Both default to 0 and only change the target record, never the 40/10/15/15/20
//   operation mix.
//
// One iteration = exactly one HTTP request. There are no retries, and the only
// non-iteration request is the optional setup() DB-RTT probe.
//
// Failure tags never include response messages or URLs: only status, the safe
// body error `code` (regex-checked), and the safe `x-teable-v2-feature` header.
// x-teable-v2 is counted for every response, per operation, with an explicit
// `missing` bucket.

import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';
import http from 'k6/http';
import { check } from 'k6';
import exec from 'k6/execution';
import {
  isExpected,
  opDuration,
  opFailures,
  randomItem,
  traceparent,
  valueFor,
} from '../lib/http.js';

var TAKE_CAP = 100;
var MAX_BUCKETS = 240;
var BUCKET_TAG_WIDTH = 3;

var EXPECTED_OPS = ['list', 'get', 'create', 'update', 'computed'];
// Operation mix in percent. This is the C0 contract and must not drift.
var MIX = { list: 40, get: 10, create: 15, update: 15, computed: 20 };

var ERROR_RATE_MAX = 0.01;
var P99_MAX_MS = 2000;
var PLATEAU_P95_MAX_MS = 1000;

var baseUrl = (__ENV.BASE_URL || '').replace(/\/+$/, '');
var token = __ENV.TOKEN || '';
var tableId = __ENV.TABLE_ID || '';
var runId = __ENV.RUN_ID || '';
var stepName = __ENV.STEP_NAME || '';
// STEP_TARGET is a per-second arrival rate and may be fractional (12.5 rps for the
// T8078 step). k6 requires integer arrival rates per timeUnit, so the unit is
// widened until both the target and its 50% warm rate are integers.
var target = toPositiveNumber('STEP_TARGET', Number(__ENV.STEP_TARGET || 10));
var apiKind = __ENV.API_KIND || 'v1';

var warmupSec = durationSec('STEP_WARMUP_SEC', 'STEP_WARMUP_MIN', 600);
var rampSec = durationSec('STEP_RAMP_SEC', 'STEP_RAMP_MIN', 600);
var plateauSec = durationSec('STEP_PLATEAU_SEC', 'STEP_PLATEAU_MIN', 1800);
var totalSec = warmupSec + rampSec + plateauSec;

var takeRequested = toPositiveInt('TAKE', Number(__ENV.TAKE || 50));
var take = Math.min(TAKE_CAP, takeRequested);

var warm = target * 0.5;
var rates = arrivalRates(target);
var preVus = toPositiveInt('PRE_VUS', __ENV.PRE_VUS ? Number(__ENV.PRE_VUS) : Math.max(50, Math.ceil(target * 2)));
var maxVus = toPositiveInt('MAX_VUS', __ENV.MAX_VUS ? Number(__ENV.MAX_VUS) : Math.max(200, Math.ceil(target * 8)));
if (maxVus < preVus) throw new Error('MAX_VUS must be >= PRE_VUS (got ' + maxVus + ' < ' + preVus + ')');

var guardDelaySec = durationSec('GUARDRAIL_DELAY_SEC', null, warmupSec);

var idsFile = __ENV.RECORD_IDS_FILE || '';
// typecast=false is the realistic UI path and avoids the v2 schema-coordination lock
// that typecast=true takes on every update (see s25 root-cause). Env-driven;
// the resolved value is recorded in meta.typecast for the evidence writer.
var typecastDefaulted = __ENV.TYPECAST === undefined || __ENV.TYPECAST === '';
var typecast = __ENV.TYPECAST === 'true';
var ids = new SharedArray('c0_record_ids', function () {
  if (!idsFile) return [];
  var parsed = JSON.parse(open(idsFile));
  if (!Array.isArray(parsed)) {
    throw new Error('RECORD_IDS_FILE must contain a JSON array of record ids');
  }
  for (var i = 0; i < parsed.length; i++) {
    if (typeof parsed[i] !== 'string' || parsed[i].length === 0) {
      throw new Error('RECORD_IDS_FILE entry ' + i + ' is not a non-empty string id');
    }
  }
  return parsed;
});

var idsLoaded = ids.length;
var summaryPath = __ENV.SUMMARY_PATH || 'summary-c0.json';
var rawOutPath = __ENV.RAW_OUT || '';

// --- supervisor configuration -------------------------------------------------
var supWindowSec = toPositiveInt('SUPERVISOR_WINDOW_SEC', Number(__ENV.SUPERVISOR_WINDOW_SEC || 60));
var supGraceSec = toPositiveInt('SUPERVISOR_GRACE_SEC', Number(__ENV.SUPERVISOR_GRACE_SEC || 5));
if (supGraceSec >= supWindowSec) {
  throw new Error(
    'SUPERVISOR_GRACE_SEC (' + supGraceSec + ') must be smaller than SUPERVISOR_WINDOW_SEC (' + supWindowSec + ')'
  );
}
var droppedPctMax = pctEnv('GUARDRAIL_DROPPED_PCT', 5);
var droppedFractionMax = droppedPctMax / 100;

var bucketCount = Math.ceil(totalSec / supWindowSec);
if (bucketCount > MAX_BUCKETS) {
  throw new Error(
    'SUPERVISOR_WINDOW_SEC=' +
      supWindowSec +
      ' needs ' +
      bucketCount +
      ' buckets for ' +
      totalSec +
      's; the limit is ' +
      MAX_BUCKETS +
      ' (raise SUPERVISOR_WINDOW_SEC)'
  );
}

var bucketPlan = buildBucketPlan();
var supervisedBuckets = 0;
for (var bp = 0; bp < bucketPlan.length; bp++) {
  if (bucketPlan[bp].supervised) supervisedBuckets++;
}

// --- C0 v2 profile (default OFF, does not change the mix) ---------------------
var hotRowPct = pctEnv('V2_HOT_ROW_PCT', 0);
var hotRecordIdEnv = __ENV.V2_HOT_RECORD_ID || '';
var crossPct = pctEnv('V2_CROSS_TABLE_PCT', 0);
var crossTableId = __ENV.V2_CROSS_TABLE_ID || '';
var crossRecordId = __ENV.V2_CROSS_TABLE_RECORD_ID || '';
var crossField = __ENV.V2_CROSS_TABLE_FIELD || 'Qty';
var v2ProfileEnabled = hotRowPct > 0 || crossPct > 0;
if (!/^[A-Za-z0-9_. -]{1,60}$/.test(crossField)) {
  throw new Error('V2_CROSS_TABLE_FIELD must be a plain field name, got a value with unsafe characters');
}
if (hotRowPct === 0 && hotRecordIdEnv) {
  // Not fatal: the id is simply unused when the percentage is 0.
}
var hotRecordId = hotRecordIdEnv;
var hotRecordSource = hotRowPct === 0 ? 'off' : hotRecordIdEnv ? 'env:V2_HOT_RECORD_ID' : 'record_ids[0]';

// --- declared window start (so an external sampler can align while running) ---
var declaredStartMs = null;
if (__ENV.RUN_STARTED_EPOCH_MS !== undefined && __ENV.RUN_STARTED_EPOCH_MS !== '') {
  declaredStartMs = toPositiveInt('RUN_STARTED_EPOCH_MS', Number(__ENV.RUN_STARTED_EPOCH_MS));
  if (declaredStartMs < 1000000000000) {
    throw new Error('RUN_STARTED_EPOCH_MS must be epoch milliseconds (got ' + declaredStartMs + ')');
  }
}

// --- optional app->DB round-trip probe ---------------------------------------
var appDbRttPath = __ENV.APP_DB_RTT_PROBE_PATH || '';
var appDbRttSamples = toPositiveInt('APP_DB_RTT_PROBE_SAMPLES', Number(__ENV.APP_DB_RTT_PROBE_SAMPLES || 5));
if (appDbRttSamples > 20) throw new Error('APP_DB_RTT_PROBE_SAMPLES must be <= 20, got ' + appDbRttSamples);
if (appDbRttPath && appDbRttPath.charAt(0) !== '/') appDbRttPath = '/' + appDbRttPath;

// --- computed-worker presence -------------------------------------------------
var computedWorkerPresent = null;
if (__ENV.COMPUTED_WORKER_PRESENT !== undefined && __ENV.COMPUTED_WORKER_PRESENT !== '') {
  var cwRaw = String(__ENV.COMPUTED_WORKER_PRESENT).toLowerCase();
  if (cwRaw !== 'true' && cwRaw !== 'false') {
    throw new Error('COMPUTED_WORKER_PRESENT must be true or false (got ' + __ENV.COMPUTED_WORKER_PRESENT + ')');
  }
  computedWorkerPresent = cwRaw === 'true';
}

// --- local-only failure injection (never valid outside loopback) --------------
var debugFailRate = nonNegativeNumber('DEBUG_FAIL_RATE', Number(__ENV.DEBUG_FAIL_RATE || 0));
if (debugFailRate > 1) throw new Error('DEBUG_FAIL_RATE must be a fraction 0..1, got ' + debugFailRate);
if (debugFailRate > 0 && !isLoopbackUrl(baseUrl)) {
  throw new Error(
    'DEBUG_FAIL_RATE is for local verification only and requires a loopback BASE_URL ' +
      '(127.0.0.1 / localhost / [::1]); refusing to inject failures into ' +
      (baseUrl || '<empty>')
  );
}

// --- metrics -----------------------------------------------------------------
// c0_http_failures: one count per unexpected response, sliced by op/phase/status
// and the safe body error code + x-teable-v2-feature header.
export var httpFailures = new Counter('c0_http_failures');
// c0_x_teable_v2: one count per response (including network failures), sliced by
// op/phase and value=true|false|missing|other.
export var v2Ratio = new Counter('c0_x_teable_v2');
// c0_request_failed: authoritative operation-level error rate. Unlike the
// built-in http_req_failed (which treats any 3xx as success), this counts every
// response whose status is not the operation's expected status, plus network
// failures. It feeds the per-bucket error supervisor.
export var requestFailed = new Rate('c0_request_failed');
// c0_iterations_started: exact arrivals that actually started, per bucket. The
// planned-schedule integral minus this count is the per-bucket drop estimate in
// meta.droppedIterations (exact, but only available at test end).
export var iterationsStarted = new Counter('c0_iterations_started');
// Dropped iterations are supervised live through k6's own dropped_iterations
// counter: one cumulative budget threshold per bucket (count<=budget for the
// arrivals planned up to that bucket). A cumulative COUNT threshold reacts as
// soon as drops happen (unlike a cumulative rate), and it passes with zero
// samples, so buckets that never ran cannot produce phantom breaches.
// c0_app_db_rtt_ms: optional setup probe (client -> app -> DB -> app -> client).
export var appDbRtt = new Trend('c0_app_db_rtt_ms', true);
// c0_debug_injected_failures: only non-zero when DEBUG_FAIL_RATE is set locally.
export var debugInjected = new Counter('c0_debug_injected_failures');

export var options = {
  // Record every quantile the evidence contract consumes. Without this, the
  // summary omits p(99) and the per-bucket / plateau submetrics would not be
  // self-contained.
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'count', 'p(50)', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)'],
  // Never follow redirects: a 3xx is a wrong target/route, not a successful op.
  maxRedirects: 0,
  // 3xx is not expected by any C0 operation; requestFailed below is the
  // authoritative error-rate metric so the supervisor cannot miss a redirect.
  scenarios: {
    c0: {
      executor: 'ramping-arrival-rate',
      startRate: rates.warmPerUnit,
      timeUnit: rates.timeUnitSec + 's',
      preAllocatedVUs: preVus,
      maxVUs: maxVus,
      stages: [
        // startRate == target keeps the warm phase exactly at 50%, not a ramp.
        { duration: warmupSec + 's', target: rates.warmPerUnit },
        { duration: rampSec + 's', target: rates.targetPerUnit },
        { duration: plateauSec + 's', target: rates.targetPerUnit },
      ],
    },
  },
  thresholds: supervisorThresholds(),
};

// k6 arrival-rate executors take integer rates per timeUnit. A fractional
// per-second target (12.5 rps) is expressed exactly by widening timeUnit, so
// both the target and its 50% warm-up rate stay integers; 12.5 rps becomes
// 50 arrivals per 4s with a 25-per-4s warm phase. No rounding: if no unit in
// the ladder makes the pair integral the step is rejected rather than silently
// shifting the arrival rate.
function isIntegral(value) {
  return Math.abs(value - Math.round(value)) < 1e-9;
}

function arrivalRates(perSecond) {
  var candidates = [1, 2, 4, 8, 16, 32, 64];
  var warmPerSecond = perSecond * 0.5;
  for (var i = 0; i < candidates.length; i++) {
    var unitSec = candidates[i];
    var targetPerUnit = perSecond * unitSec;
    var warmPerUnit = warmPerSecond * unitSec;
    if (isIntegral(targetPerUnit) && isIntegral(warmPerUnit)) {
      return {
        timeUnitSec: unitSec,
        targetPerUnit: Math.round(targetPerUnit),
        warmPerUnit: Math.round(warmPerUnit),
        targetPerSecond: perSecond,
        warmPerSecond: warmPerSecond,
        perMinute: perSecond * 60,
        warmPerMinute: warmPerSecond * 60,
      };
    }
  }
  throw new Error(
    'STEP_TARGET=' +
      String(perSecond) +
      ' cannot be expressed as an integer arrival rate within ' +
      String(candidates[candidates.length - 1]) +
      's; use a target with at most two decimal places'
  );
}

function toPositiveInt(name, value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(name + ' must be a positive integer, got ' + String(value));
  }
  return value;
}

function toPositiveNumber(name, value) {
  if (!isFinite(value) || value <= 0) {
    throw new Error(name + ' must be a positive number, got ' + String(value));
  }
  return value;
}

function nonNegativeNumber(name, value) {
  if (!isFinite(value) || value < 0) {
    throw new Error(name + ' must be a non-negative number, got ' + String(value));
  }
  return value;
}

function pctEnv(name, fallback) {
  var raw = __ENV[name];
  if (raw === undefined || raw === '') return fallback;
  var value = Number(raw);
  if (!isFinite(value) || value < 0 || value > 100) {
    throw new Error(name + ' must be a percentage between 0 and 100, got ' + String(raw));
  }
  return value;
}

function durationSec(secEnv, minEnv, fallbackSec) {
  var rawSec = __ENV[secEnv];
  if (rawSec !== undefined && rawSec !== '') {
    return toPositiveInt(secEnv, Number(rawSec));
  }
  if (minEnv) {
    var rawMin = __ENV[minEnv];
    if (rawMin !== undefined && rawMin !== '') {
      return Math.max(1, Math.round(toPositiveNumber(minEnv, Number(rawMin)) * 60));
    }
  }
  return fallbackSec;
}

function isLoopbackUrl(url) {
  return /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(url);
}

function pad3(value) {
  var text = String(value);
  while (text.length < BUCKET_TAG_WIDTH) text = '0' + text;
  return text;
}

function bucketTag(index) {
  return 'B' + pad3(index);
}

// Planned arrival rate at a point in time (per second). Inclusive at the end of
// the planned window so the last trapezoid is not halved.
function rateAtSec(tSec) {
  if (tSec <= warmupSec) return warm;
  if (tSec <= warmupSec + rampSec) {
    return warm + ((target - warm) * (tSec - warmupSec)) / rampSec;
  }
  if (tSec <= totalSec) return target;
  return 0;
}

function expectedArrivals(startSec, endSec) {
  if (endSec <= startSec) return 0;
  var cuts = [startSec];
  var rampStart = warmupSec;
  var rampEnd = warmupSec + rampSec;
  if (rampStart > startSec && rampStart < endSec) cuts.push(rampStart);
  if (rampEnd > startSec && rampEnd < endSec) cuts.push(rampEnd);
  cuts.push(endSec);
  var total = 0;
  for (var i = 0; i + 1 < cuts.length; i++) {
    // rate is linear between adjacent stage boundaries, so the trapezoid is exact
    total += ((rateAtSec(cuts[i]) + rateAtSec(cuts[i + 1])) / 2) * (cuts[i + 1] - cuts[i]);
  }
  return total;
}

function phaseForSec(sec) {
  if (sec < warmupSec) return 'warm';
  if (sec < warmupSec + rampSec) return 'ramp';
  if (sec < totalSec) return 'plateau';
  return 'drain';
}

function buildBucketPlan() {
  var plan = [];
  var cumulative = 0;
  var lastBudget = 0;
  for (var i = 0; i < bucketCount; i++) {
    var startSec = i * supWindowSec;
    var endSec = Math.min(startSec + supWindowSec, totalSec);
    var evalAtSec = endSec + supGraceSec;
    var expected = expectedArrivals(startSec, endSec);
    cumulative += expected;
    // Allowed cumulative drops up to and including this bucket. k6's
    // dropped_iterations counter is cumulative, so the budget must be too.
    // Budgets are forced to be strictly increasing so each bucket owns a distinct
    // threshold expression (and therefore its own activation time and result);
    // the cost is at most one extra allowed drop.
    var budget = Math.floor(cumulative * droppedFractionMax);
    if (budget <= lastBudget) budget = lastBudget + 1;
    lastBudget = budget;
    plan.push({
      index: i,
      tag: bucketTag(i),
      startSec: startSec,
      endSec: endSec,
      evalAtSec: evalAtSec,
      phase: phaseForSec(startSec),
      expected: expected,
      cumulativeExpected: cumulative,
      // Cumulative drop budget up to this bucket (see the computation above).
      dropBudget: budget,
      // Supervised only when the bucket starts after the guardrail delay AND its
      // evaluation deadline still falls inside the run.
      supervised: startSec >= guardDelaySec && evalAtSec <= totalSec,
    });
  }
  return plan;
}

function bucketIndexFor(elapsedMs) {
  var index = Math.floor(elapsedMs / (supWindowSec * 1000));
  if (index < 0) return 0;
  if (index >= bucketCount) return bucketCount - 1;
  return index;
}

// Per-bucket thresholds: the abort decisions, plus reporting-only submetrics so
// warm buckets and per-bucket quantiles are always materialised.
function supervisorThresholds() {
  var out = {};
  var dropThresholds = [];
  for (var i = 0; i < bucketPlan.length; i++) {
    var b = bucketPlan[i];
    var startedKey = 'c0_iterations_started{bucket:' + b.tag + '}';
    var durationKey = 'http_req_duration{bucket:' + b.tag + '}';
    var failedKey = 'c0_request_failed{bucket:' + b.tag + '}';
    // Exact arrival count per bucket, for every bucket (the drop accounting in
    // the summary needs warm buckets too). Reporting-only: never aborts.
    out[startedKey] = ['count>=0'];
    if (!b.supervised) {
      out[durationKey] = ['avg>=0'];
      out[failedKey] = ['rate>=0'];
      continue;
    }
    var delay = b.evalAtSec + 's';
    out[failedKey] = [
      { threshold: 'rate<=' + ERROR_RATE_MAX, abortOnFail: true, delayAbortEval: delay },
    ];
    out[durationKey] = [
      { threshold: 'p(99)<=' + P99_MAX_MS, abortOnFail: true, delayAbortEval: delay },
    ];
    // Cumulative drop budget up to this bucket: becomes active at this bucket's
    // deadline and aborts as soon as the cumulative count exceeds it. Budgets
    // are non-decreasing, so the newest active threshold is always the binding
    // one and earlier ones stay satisfied.
    dropThresholds.push({
      threshold: dropBudgetExpr(b),
      abortOnFail: true,
      delayAbortEval: delay,
    });
  }
  out['dropped_iterations'] = dropThresholds;

  // Reporting-only cumulative thresholds. These never abort: a 1-minute burst
  // barely moves a cumulative rate, so abort is decided per bucket above.
  out['c0_request_failed'] = ['rate<=' + ERROR_RATE_MAX];
  out['http_req_duration'] = ['p(99)<=' + P99_MAX_MS];
  // Plateau-only SLO, evaluated end-of-test (no abort).
  out['http_req_duration{phase:plateau}'] = ['p(95)<=' + PLATEAU_P95_MAX_MS];
  // Materialise warm/ramp quantiles.
  out['http_req_duration{phase:warm}'] = ['avg>=0'];
  out['http_req_duration{phase:ramp}'] = ['avg>=0'];
  out['c0_app_db_rtt_ms'] = ['avg>=0'];
  out['c0_debug_injected_failures'] = ['count>=0'];
  out['c0_x_teable_v2{value:true}'] = ['count>=0'];
  out['c0_x_teable_v2{value:false}'] = ['count>=0'];
  out['c0_x_teable_v2{value:missing}'] = ['count>=0'];
  out['c0_x_teable_v2{value:other}'] = ['count>=0'];

  // One materialised result row per operation: duration + error rate + volume.
  for (var op = 0; op < EXPECTED_OPS.length; op++) {
    var name = EXPECTED_OPS[op];
    out['teable_op_duration{op:' + name + '}'] = ['avg>=0'];
    out['c0_request_failed{op:' + name + '}'] = ['rate>=0'];
    out['http_reqs{op:' + name + '}'] = ['count>=0'];
  }
  return out;
}

// The threshold expression for a bucket's cumulative drop budget. Used both to
// declare the threshold and to read its result back into summary meta.
function dropBudgetExpr(plan) {
  return 'count<=' + plan.dropBudget;
}

function basename(path) {
  if (!path) return '';
  var parts = String(path).split(/[\\/]/);
  return parts[parts.length - 1];
}

function headerValue(res, name) {
  if (!res || !res.headers) return '';
  var value = res.headers[name];
  if (value === undefined) value = res.headers[name.toLowerCase()];
  if (value === undefined) value = res.headers[name.toUpperCase()];
  if (value === undefined || value === null) return '';
  return String(value);
}

function safeToken(value) {
  if (typeof value !== 'string' || value.length === 0) return 'missing';
  if (!/^[A-Za-z0-9_.:\/-]{1,80}$/.test(value)) return 'invalid';
  return value;
}

function safeErrorCode(res) {
  if (!res) return 'missing';
  if (res.status === 0) return 'network';
  var body;
  try {
    body = res.json();
  } catch (e) {
    return 'unparsed';
  }
  if (!body || typeof body !== 'object') return 'missing';
  if (body.code !== undefined) return safeToken(body.code);
  if (body.data && body.data.dataDb && body.data.dataDb.code !== undefined) {
    return safeToken(body.data.dataDb.code);
  }
  return 'missing';
}

function safeFeature(res) {
  return safeToken(headerValue(res, 'x-teable-v2-feature'));
}

function v2Value(res) {
  var raw = headerValue(res, 'x-teable-v2').trim().toLowerCase();
  if (!raw) return 'missing';
  if (raw === 'true' || raw === 'false') return raw;
  return 'other';
}

function headers(phase, bucket) {
  return {
    Authorization: 'Bearer ' + token,
    'Content-Type': 'application/json',
    traceparent: traceparent(),
    baggage:
      'teable.loadtest.run_id=' +
      encodeURIComponent(runId) +
      ',teable.loadtest.scenario=C0-' +
      encodeURIComponent(stepName) +
      ',teable.loadtest.phase=' +
      encodeURIComponent(phase) +
      ',teable.loadtest.step=' +
      encodeURIComponent(stepName) +
      ',teable.loadtest.bucket=' +
      encodeURIComponent(bucket) +
      ',teable.loadtest.api=' +
      encodeURIComponent(apiKind),
    // Machine-readable window tag for ingress/app logs: bounded to the bucket
    // count, joins 1:1 with meta.sampling.buckets[].tag.
    'x-c0-bucket': bucket,
    'x-window-id': 'lt-' + runId + '-' + stepName + '-' + __VU + '-' + __ITER,
  };
}

function call(method, url, body, op, expected) {
  var elapsedMs = exec.instance.currentTestRunDuration;
  var bucket = bucketTag(bucketIndexFor(elapsedMs));
  var phase = phaseForSec(elapsedMs / 1000);

  iterationsStarted.add(1, { bucket: bucket, phase: phase });

  var tags = { op: op, phase: phase, api: apiKind, bucket: bucket };
  var params = { headers: headers(phase, bucket), tags: tags };
  var payload = body === null || body === undefined ? null : JSON.stringify(body);
  var res = http.request(method, url, payload, params);

  opDuration.add(res.timings.duration, tags);

  var ok = check(res, {
    ['status ' + op]: function (r) {
      return isExpected(r.status, expected);
    },
  });

  var injected = debugFailRate > 0 && Math.random() < debugFailRate;
  if (injected) {
    ok = false;
    debugInjected.add(1, { op: op });
  }

  requestFailed.add(ok ? 0 : 1, tags);

  if (!ok) {
    var failureTags = {
      op: op,
      phase: phase,
      api: apiKind,
      bucket: bucket,
      status: String(res.status),
      code: injected ? 'injected' : safeErrorCode(res),
      feature: safeFeature(res),
    };
    if (injected) failureTags.injected = 'true';
    opFailures.add(1, failureTags);
    httpFailures.add(1, failureTags);
  }

  v2Ratio.add(1, { op: op, phase: phase, value: v2Value(res) });
  return res;
}

function pickId() {
  return randomItem(ids);
}

function pickHotRecordId() {
  if (!hotRecordId) hotRecordId = ids[0];
  return hotRecordId;
}

function singleField(field, value) {
  var fields = {};
  fields[field] = value;
  return fields;
}

function probeAppDbRtt() {
  var result = {
    enabled: false,
    path: null,
    valueMs: null,
    samples: 0,
    includesClientToAppMs: true,
    source: 'k6 setup() request (client -> app -> DB -> app -> client)',
    note:
      'unset APP_DB_RTT_PROBE_PATH: App_DB_RTT_ms must be recorded as null, never 0; ' +
      'the app->DB component needs an external probe (see the scenario header)',
  };
  if (!appDbRttPath) return result;

  var url = baseUrl + appDbRttPath;
  var timings = [];
  var lastStatus = 0;
  for (var i = 0; i < appDbRttSamples; i++) {
    var res = http.get(url, {
      headers: {
        Authorization: 'Bearer ' + token,
        traceparent: traceparent(),
        baggage: 'teable.loadtest.run_id=' + encodeURIComponent(runId) + ',teable.loadtest.scenario=probe',
      },
      tags: { op: 'db_rtt_probe', phase: 'setup', api: apiKind },
    });
    lastStatus = res.status;
    if (res.status < 200 || res.status >= 300) break;
    timings.push(res.timings.duration);
    appDbRtt.add(res.timings.duration, { source: 'setup-probe' });
  }

  result.enabled = true;
  result.path = appDbRttPath;
  result.samples = timings.length;
  result.status = lastStatus;
  result.includesClientToAppMs = true;
  result.source = 'k6 setup() request (client -> app -> DB -> app -> client)';
  if (timings.length === 0) {
    result.note =
      'probe returned a non-2xx status: App_DB_RTT_ms must be recorded as null, never 0';
    return result;
  }
  timings.sort(function (a, b) {
    return a - b;
  });
  var sum = 0;
  for (var t = 0; t < timings.length; t++) sum += timings[t];
  result.minMs = round3(timings[0]);
  result.maxMs = round3(timings[timings.length - 1]);
  result.medianMs = round3(timings[Math.floor(timings.length / 2)]);
  result.avgMs = round3(sum / timings.length);
  result.valueMs = result.medianMs;
  result.note =
    'client-side round trip including client->app; subtract the external app->DB probe value to isolate the DB hop';
  return result;
}

export function setup() {
  if (!baseUrl) throw new Error('BASE_URL is required');
  if (__ENV.STEP_TARGET === undefined || __ENV.STEP_TARGET === '') {
    throw new Error('STEP_TARGET is required (e.g. 12.5 / 25 / 75 / 150 for the C0 ladder)');
  }
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('BASE_URL must start with http:// or https://');
  if (!token) throw new Error('TOKEN is required');
  if (!tableId) throw new Error('TABLE_ID is required');
  if (!idsFile) throw new Error('RECORD_IDS_FILE is required');
  if (!runId) throw new Error('RUN_ID is required');
  if (!stepName) throw new Error('STEP_NAME is required');
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(runId)) throw new Error('RUN_ID contains unsafe characters');
  if (!/^[A-Za-z0-9_.:-]{1,40}$/.test(stepName)) throw new Error('STEP_NAME contains unsafe characters');
  if (apiKind !== 'v1') throw new Error('C0 breakpoint uses the v1 record API; API_KIND must be v1');
  if (idsLoaded === 0) {
    throw new Error('RECORD_IDS_FILE resolved to zero ids; refusing to run an empty workload');
  }
  if (supervisedBuckets === 0) {
    throw new Error(
      'no bucket is supervised: GUARDRAIL_DELAY_SEC=' +
        guardDelaySec +
        's, SUPERVISOR_WINDOW_SEC=' +
        supWindowSec +
        's and the planned run is ' +
        totalSec +
        's; the step would have no per-bucket abort'
    );
  }
  if (crossPct > 0) {
    if (!crossTableId) throw new Error('V2_CROSS_TABLE_PCT > 0 requires V2_CROSS_TABLE_ID');
    if (!crossRecordId) throw new Error('V2_CROSS_TABLE_PCT > 0 requires V2_CROSS_TABLE_RECORD_ID');
  }
  if (hotRowPct > 0 && !hotRecordId) hotRecordId = ids[0];

  var appDbRttResult = probeAppDbRtt();

  return {
    recordIds: idsLoaded,
    target: target,
    warm: warm,
    phases: { warmupSec: warmupSec, rampSec: rampSec, plateauSec: plateauSec },
    take: take,
    buckets: bucketCount,
    supervisedBuckets: supervisedBuckets,
    appDbRtt: appDbRttResult,
  };
}

export default function () {
  var roll = Math.random() * 100;
  var recordId;

  if (roll < MIX.list) {
    call(
      'GET',
      baseUrl +
        '/api/table/' +
        encodeURIComponent(tableId) +
        '/record?take=' +
        take +
        '&fieldKeyType=name',
      null,
      'list',
      200
    );
    return;
  }

  recordId = pickId();
  if (!recordId) {
    // setup() already rejects an empty id set; this protects against a corrupted
    // SharedArray at runtime instead of silently emitting zero-load iterations.
    throw new Error(
      'no record id available for ' +
        (roll < MIX.list + MIX.get
          ? 'get'
          : roll < MIX.list + MIX.get + MIX.create + MIX.update
            ? 'write'
            : 'computed')
    );
  }

  if (roll < MIX.list + MIX.get) {
    call(
      'GET',
      baseUrl + '/api/table/' + encodeURIComponent(tableId) + '/record/' + encodeURIComponent(recordId),
      null,
      'get',
      200
    );
    return;
  }

  if (roll < MIX.list + MIX.get + MIX.create) {
    call(
      'POST',
      baseUrl + '/api/table/' + encodeURIComponent(tableId) + '/record',
      {
        fieldKeyType: 'name',
        typecast: typecast,
        records: [
          {
            fields: {
              Name: valueFor({ fieldValuePrefix: 'c0' }),
              Qty: Math.floor(Math.random() * 100),
              Price: Math.random() * 100,
              Status: 'open',
            },
          },
        ],
      },
      'create',
      201
    );
    return;
  }

  if (roll < MIX.list + MIX.get + MIX.create + MIX.update) {
    // C0 v2 hot-row profile: redirect a share of writes to one hot record.
    // Percent 0 (default) leaves the target distribution untouched.
    if (hotRowPct > 0 && Math.random() * 100 < hotRowPct) recordId = pickHotRecordId();
    call(
      'PATCH',
      baseUrl + '/api/table/' + encodeURIComponent(tableId) + '/record/' + encodeURIComponent(recordId),
      {
        fieldKeyType: 'name',
        typecast: typecast,
        record: { fields: { Name: valueFor({ fieldValuePrefix: 'c0u' }) } },
      },
      'update',
      200
    );
    return;
  }

  // computed (20%): update the source value that triggers the computed chain.
  // C0 v2 cross-table profile (default off): write on the cross table instead,
  // so the recompute has to traverse the lookup into this table.
  if (crossPct > 0 && Math.random() * 100 < crossPct) {
    call(
      'PATCH',
      baseUrl +
        '/api/table/' +
        encodeURIComponent(crossTableId) +
        '/record/' +
        encodeURIComponent(crossRecordId),
      {
        fieldKeyType: 'name',
        typecast: typecast,
        record: { fields: singleField(crossField, Math.floor(Math.random() * 1000)) },
      },
      'computed',
      200
    );
    return;
  }

  if (hotRowPct > 0 && Math.random() * 100 < hotRowPct) recordId = pickHotRecordId();
  call(
    'PATCH',
    baseUrl + '/api/table/' + encodeURIComponent(tableId) + '/record/' + encodeURIComponent(recordId),
    {
      fieldKeyType: 'name',
      typecast: typecast,
      record: { fields: { Qty: Math.floor(Math.random() * 1000) } },
    },
    'computed',
    200
  );
}

function round3(value) {
  if (typeof value !== 'number' || !isFinite(value)) return null;
  return Math.round(value * 1000) / 1000;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function metaPathFor(path) {
  if (/\.json$/i.test(path)) return path.replace(/\.json$/i, '.run.json');
  return path + '.run.json';
}

function metricOf(data, name) {
  return data && data.metrics && data.metrics[name] ? data.metrics[name] : null;
}

function valuesOf(data, name) {
  var metric = metricOf(data, name);
  return metric && metric.values ? metric.values : null;
}

function num(value) {
  return typeof value === 'number' && isFinite(value) ? value : null;
}

function pickNumber(values, keys) {
  if (!values) return null;
  for (var i = 0; i < keys.length; i++) {
    var value = num(values[keys[i]]);
    if (value !== null) return value;
  }
  return null;
}

function thresholdOk(data, name, expression) {
  var metric = metricOf(data, name);
  var thresholds = metric && metric.thresholds ? metric.thresholds : null;
  if (!thresholds || !thresholds[expression]) return null;
  return thresholds[expression].ok === true;
}

function thresholdResults(data) {
  var out = {};
  var failed = [];
  var metrics = (data && data.metrics) || {};
  for (var name in metrics) {
    if (!Object.prototype.hasOwnProperty.call(metrics, name)) continue;
    var thresholds = metrics[name] && metrics[name].thresholds;
    if (!thresholds) continue;
    out[name] = {};
    for (var expr in thresholds) {
      if (!Object.prototype.hasOwnProperty.call(thresholds, expr)) continue;
      var ok = Boolean(thresholds[expr] && thresholds[expr].ok === true);
      out[name][expr] = ok;
      if (!ok) failed.push(name + ' ' + expr);
    }
  }
  return { results: out, failed: failed };
}

function durationBlock(values) {
  if (!values) return null;
  return {
    count: num(values.count),
    avgMs: num(values.avg),
    minMs: num(values.min),
    medMs: num(values.med),
    p50Ms: num(values['p(50)']),
    p90Ms: num(values['p(90)']),
    p95Ms: num(values['p(95)']),
    p99Ms: num(values['p(99)']),
    p999Ms: num(values['p(99.9)']),
    maxMs: num(values.max),
  };
}

// One result row per operation, straight from the materialised summary
// submetrics (never only from prose or from the raw NDJSON).
function operationSummary(data) {
  var out = {};
  for (var i = 0; i < EXPECTED_OPS.length; i++) {
    var op = EXPECTED_OPS[i];
    var duration = valuesOf(data, 'teable_op_duration{op:' + op + '}');
    var failed = valuesOf(data, 'c0_request_failed{op:' + op + '}');
    var requests = pickNumber(valuesOf(data, 'http_reqs{op:' + op + '}'), ['count']);
    var errorRate = failed ? num(failed.rate) : null;
    out[op] = {
      present: Boolean(duration && num(duration.count) > 0),
      mixPct: MIX[op],
      requests: requests,
      errorRate: errorRate,
      failed:
        requests !== null && errorRate !== null ? Math.round(requests * errorRate) : null,
      duration: durationBlock(duration),
    };
  }
  return out;
}

function bucketSeries(data, startMs, actualSec) {
  var rows = [];
  var totals = { plannedReached: 0, started: 0, reachedBuckets: 0 };
  for (var i = 0; i < bucketPlan.length; i++) {
    var plan = bucketPlan[i];
    var reached = actualSec >= plan.endSec;
    var startedValues = valuesOf(data, 'c0_iterations_started{bucket:' + plan.tag + '}');
    var failed = valuesOf(data, 'c0_request_failed{bucket:' + plan.tag + '}');
    var duration = valuesOf(data, 'http_req_duration{bucket:' + plan.tag + '}');

    // A materialised submetric also exists with zero samples, so every value is
    // gated on its sample count and on whether the run actually reached it.
    var started = reached ? pickNumber(startedValues, ['count']) : null;
    if (started === null && reached) started = 0;
    var durationSamples = duration ? pickNumber(duration, ['count']) : null;
    var dropped = started === null ? null : Math.max(0, plan.expected - started);

    var thresholdsOk = {
      errorRate: plan.supervised
        ? thresholdOk(data, 'c0_request_failed{bucket:' + plan.tag + '}', 'rate<=' + ERROR_RATE_MAX)
        : null,
      p99: plan.supervised
        ? thresholdOk(data, 'http_req_duration{bucket:' + plan.tag + '}', 'p(99)<=' + P99_MAX_MS)
        : null,
      dropped: plan.supervised
        ? thresholdOk(data, 'dropped_iterations', dropBudgetExpr(plan))
        : null,
    };

    rows.push({
      index: plan.index,
      tag: plan.tag,
      phase: plan.phase,
      startSec: plan.startSec,
      endSec: plan.endSec,
      startAt: iso(startMs + plan.startSec * 1000),
      endAt: iso(startMs + plan.endSec * 1000),
      startEpochMs: startMs + plan.startSec * 1000,
      endEpochMs: startMs + plan.endSec * 1000,
      supervised: plan.supervised,
      evalAtSec: plan.supervised ? plan.evalAtSec : null,
      reached: reached,
      expectedArrivals: round3(plan.expected),
      cumulativeExpectedArrivals: round3(plan.cumulativeExpected),
      started: started,
      requests: started,
      errorRate: started !== null && started > 0 && failed ? num(failed.rate) : null,
      p99Ms: durationSamples !== null && durationSamples > 0 ? num(duration['p(99)']) : null,
      p95Ms: durationSamples !== null && durationSamples > 0 ? num(duration['p(95)']) : null,
      dropped: dropped,
      droppedRate:
        dropped !== null && plan.expected > 0 ? round3(dropped / plan.expected) : null,
      // Cumulative drop budget supervised at this bucket. k6 only reports the
      // cumulative counter at test end, so the cap lives here and the observed
      // total lives in meta.droppedIterations.k6.count.
      dropBudget: plan.supervised ? plan.dropBudget : null,
      dropBudgetThreshold: plan.supervised ? dropBudgetExpr(plan) : null,
      thresholdsOk: thresholdsOk,
      // true means the bucket BREACHED its threshold (null = not evaluated)
      breaches: {
        errorRate: thresholdsOk.errorRate === null ? null : thresholdsOk.errorRate === false,
        p99: thresholdsOk.p99 === null ? null : thresholdsOk.p99 === false,
        dropped: thresholdsOk.dropped === null ? null : thresholdsOk.dropped === false,
      },
    });

    if (reached) {
      totals.reachedBuckets += 1;
      totals.plannedReached += plan.expected;
      if (started !== null) totals.started += started;
    }
  }
  return { rows: rows, totals: totals };
}

function sumPlannedArrivals() {
  var total = 0;
  for (var i = 0; i < bucketPlan.length; i++) total += bucketPlan[i].expected;
  return total;
}

// Only buckets whose evaluation deadline actually elapsed during the run can
// have caused a mid-run abort; later ones are evaluated by k6 at end-of-test
// and are reported separately.
function firstBreachOf(rows, actualSec) {
  for (var i = 0; i < rows.length; i++) {
    var row = rows[i];
    if (!row.supervised || row.evalAtSec === null || row.evalAtSec > actualSec) continue;
    var checks = [
      {
        metric: 'c0_request_failed{bucket:' + row.tag + '}',
        threshold: 'rate<=' + ERROR_RATE_MAX,
        observed: row.errorRate,
        breached: row.breaches.errorRate,
      },
      {
        metric: 'http_req_duration{bucket:' + row.tag + '}',
        threshold: 'p(99)<=' + P99_MAX_MS,
        observed: row.p99Ms,
        breached: row.breaches.p99,
      },
      {
        metric: 'dropped_iterations',
        threshold: row.dropBudgetThreshold,
        // k6 reports the cumulative counter only at test end, so there is no
        // per-bucket observed value; the total is in meta.droppedIterations.k6.
        observed: null,
        breached: row.breaches.dropped,
      },
    ];
    for (var c = 0; c < checks.length; c++) {
      if (checks[c].breached === true) {
        return {
          bucket: row.index,
          bucketTag: row.tag,
          startSec: row.startSec,
          endSec: row.endSec,
          evaluatedAtSec: row.evalAtSec,
          metric: checks[c].metric,
          threshold: checks[c].threshold,
          observed: checks[c].observed,
        };
      }
    }
  }
  return null;
}

export function handleSummary(data) {
  var endedAtMs = Math.round(Date.now());
  var durationMs = data && data.state && Number(data.state.testRunDurationMs);
  if (!isFinite(durationMs) || durationMs < 0) durationMs = 0;
  var derivedStartMs = Math.round(endedAtMs - durationMs);
  var actualSec = Math.round(durationMs / 1000);
  var endedEarly = actualSec + 1 < totalSec;
  var thresholds = thresholdResults(data);
  var series = bucketSeries(data, derivedStartMs, actualSec);
  var firstBreach = firstBreachOf(series.rows, actualSec);
  var abortTriggered = firstBreach !== null && endedEarly;

  // Buckets whose evaluation deadline fell after the abort were only evaluated
  // by k6 at end-of-test; they are reported, never treated as the abort cause.
  var notDueFailures = [];
  for (var nb = 0; nb < series.rows.length; nb++) {
    var row = series.rows[nb];
    if (!row.supervised || row.evalAtSec === null || row.evalAtSec <= actualSec) continue;
    if (row.breaches.errorRate === true || row.breaches.p99 === true || row.breaches.dropped === true) {
      notDueFailures.push(row.tag);
    }
  }

  var k6Dropped = valuesOf(data, 'dropped_iterations');
  var startedTotal = series.totals.started;
  var plannedReached = series.totals.plannedReached;
  var derivedDropped = Math.max(0, plannedReached - startedTotal);

  var appDbRttValues = valuesOf(data, 'c0_app_db_rtt_ms');
  var appDbRttCount = pickNumber(appDbRttValues, ['count']);
  var appDbRttUsable = Boolean(appDbRttPath) && appDbRttCount !== null && appDbRttCount > 0;
  var appDbRttMeta = {
    enabled: Boolean(appDbRttPath),
    path: appDbRttPath || null,
    valueMs: appDbRttUsable ? pickNumber(appDbRttValues, ['med', 'avg']) : null,
    minMs: appDbRttUsable ? pickNumber(appDbRttValues, ['min']) : null,
    maxMs: appDbRttUsable ? pickNumber(appDbRttValues, ['max']) : null,
    samples: appDbRttCount === null ? 0 : appDbRttCount,
    includesClientToAppMs: true,
    source: 'k6 setup() request (client -> app -> DB -> app -> client)',
    externalProbe: {
      required: true,
      reason: 'k6 cannot separate app->DB from client->app; App_DB_RTT_ms needs an external probe',
      script: 'teableio/teable-infra/scripts/loadtest/samplers/db-sampler.sh',
      note: 'record null, never 0, when no probe value exists',
    },
  };
  if (!appDbRttPath) {
    appDbRttMeta.note =
      'APP_DB_RTT_PROBE_PATH unset: valueMs is null; App_DB_RTT_ms must be recorded as null, never 0';
  } else if (!appDbRttUsable) {
    appDbRttMeta.note =
      'probe request failed: valueMs is null; App_DB_RTT_ms must be recorded as null, never 0';
  } else {
    appDbRttMeta.note =
      'client-side round trip including client->app; subtract the external app->DB probe value to isolate the DB hop';
  }

  var meta = {
    schema: 'c0-k6-run-meta/v2',
    runId: runId,
    step: stepName,
    targetRps: target,
    warmRate: warm,
    warmFraction: Number((warm / target).toFixed(4)),
    arrival: {
      requestedPerSecond: target,
      timeUnitSec: rates.timeUnitSec,
      targetPerUnit: rates.targetPerUnit,
      warmPerUnit: rates.warmPerUnit,
      resolvedPerSecond: rates.targetPerUnit / rates.timeUnitSec,
      resolvedWarmPerSecond: rates.warmPerUnit / rates.timeUnitSec,
      arrivalsPerMinute: rates.perMinute,
      warmArrivalsPerMinute: rates.warmPerMinute,
      exact: rates.targetPerUnit / rates.timeUnitSec === target,
      smallestIntegralUnit: rates.timeUnitSec,
      note: 'fractional STEP_TARGET is expressed by widening timeUnit; the warm rate must stay integral too',
    },
    scenario: 'C0',
    apiKind: apiKind,
    mix: { list: MIX.list, get: MIX.get, create: MIX.create, update: MIX.update, computed: MIX.computed },
    profile: {
      name: v2ProfileEnabled ? 'c0-v2' : 'c0-baseline',
      v2: {
        enabled: v2ProfileEnabled,
        hotRow: {
          pct: hotRowPct,
          appliesTo: ['update', 'computed'],
          recordIdSource: hotRecordSource,
        },
        crossTable: {
          pct: crossPct,
          appliesTo: ['computed'],
          tableIdSet: crossTableId !== '',
          recordIdSet: crossRecordId !== '',
          field: crossField,
        },
        note: 'both knobs default to 0/off; when off the request mix and targets match the C0 baseline',
      },
    },
    typecast: {
      value: typecast,
      source: typecastDefaulted ? 'default' : 'env',
      env: typecastDefaulted ? null : String(__ENV.TYPECAST),
      default: false,
      note: 'typecast=false is the realistic UI path; evidence must record this value per step',
    },
    computedWorker: {
      present: computedWorkerPresent,
      source: computedWorkerPresent === null ? 'unknown' : 'env:COMPUTED_WORKER_PRESENT',
      note:
        computedWorkerPresent === null
          ? 'not asserted: the evidence writer must store Computed_Worker_Present as null, not false'
          : 'asserted by COMPUTED_WORKER_PRESENT',
    },
    phases: {
      warmupSec: warmupSec,
      rampSec: rampSec,
      plateauSec: plateauSec,
      totalSec: totalSec,
      guardrailDelaySec: guardDelaySec,
    },
    window: {
      startedAt: iso(derivedStartMs),
      endedAt: iso(endedAtMs),
      startedAtEpochMs: derivedStartMs,
      endedAtEpochMs: endedAtMs,
      declaredStartEpochMs: declaredStartMs,
      startSource: declaredStartMs !== null ? 'declared-env' : 'derived-from-test-duration',
      declaredDeltaMs: declaredStartMs !== null ? derivedStartMs - declaredStartMs : null,
      actualDurationSec: actualSec,
      plannedDurationSec: totalSec,
      endedEarly: endedEarly,
      warmStart: iso(derivedStartMs),
      warmEnd: iso(derivedStartMs + warmupSec * 1000),
      rampEnd: iso(derivedStartMs + (warmupSec + rampSec) * 1000),
      plateauStart: iso(derivedStartMs + (warmupSec + rampSec) * 1000),
      plateauEnd: iso(derivedStartMs + totalSec * 1000),
      plateauStartEpochMs: derivedStartMs + (warmupSec + rampSec) * 1000,
      plateauEndEpochMs: derivedStartMs + totalSec * 1000,
    },
    guardrails: {
      errorRateMax: ERROR_RATE_MAX,
      p99MaxMs: P99_MAX_MS,
      plateauP95MaxMs: PLATEAU_P95_MAX_MS,
      droppedPctMax: droppedPctMax,
      abortAfterSec: guardDelaySec,
      bucketSec: supWindowSec,
      graceSec: supGraceSec,
      mode: 'per-bucket supervisor thresholds (abort) + cumulative reporting thresholds (no abort)',
      note:
        'abort decisions use per-bucket submetrics only; the cumulative error rate and P99 above are reported, never used to abort',
    },
    supervisor: {
      mechanism:
        'per-bucket submetric thresholds with abortOnFail and delayAbortEval = bucket end + grace ' +
        '(k6-native equivalent of test.abort)',
      abortCadenceNote:
        'k6 evaluates thresholds about every 2s, so an abort takes effect within ~2s of the bucket deadline',
      bucketSec: supWindowSec,
      graceSec: supGraceSec,
      bucketsTotal: bucketCount,
      bucketsSupervised: supervisedBuckets,
      thresholds: {
        errorRateMax: ERROR_RATE_MAX,
        p99MaxMs: P99_MAX_MS,
        droppedFractionMax: droppedFractionMax,
        plateauP95MaxMs: PLATEAU_P95_MAX_MS,
      },
      dropSupervision: {
        metric: 'dropped_iterations (k6 built-in, cumulative)',
        method:
          'one cumulative count threshold per supervised bucket: count<=floor(droppedPctMax% of planned arrivals up to that bucket)',
        liveBecause:
          'a cumulative COUNT threshold reacts as soon as a drop occurs; only its activation time is bucketed',
        exactPerBucketSource: 'meta.droppedIterations.byBucket (planned minus c0_iterations_started)',
        byBucket: series.rows.map(function (row) {
          return {
            tag: row.tag,
            supervised: row.supervised,
            dropBudget: row.dropBudget,
            threshold: row.dropBudgetThreshold,
            breached: row.breaches.dropped,
          };
        }),
        observedCumulativeAtEnd: pickNumber(valuesOf(data, 'dropped_iterations'), ['count']),
      },
      buckets: series.rows,
      firstBreach: firstBreach,
      abort: {
        triggered: abortTriggered,
        source: firstBreach
          ? 'supervisor-bucket-threshold'
          : endedEarly
            ? 'external-or-unknown (ended before the planned duration without a bucket breach)'
            : 'none',
        reason: firstBreach
          ? firstBreach.metric + ' ' + firstBreach.threshold + ' breached in ' + firstBreach.bucketTag
          : null,
        evaluatedAtSec: firstBreach ? firstBreach.evaluatedAtSec : null,
        endedEarly: endedEarly,
        // k6 also evaluates every remaining threshold when the test stops, so a
        // bucket that was not yet due can show up as failed. Those are listed
        // here and are never reported as the abort cause.
        notDueFailures: notDueFailures,
        note: firstBreach && !endedEarly
          ? 'a bucket threshold failed during end-of-test evaluation after the planned window; the run was not stopped mid-flight'
          : notDueFailures.length
            ? 'buckets listed in notDueFailures failed only at end-of-test evaluation after the abort'
            : null,
      },
    },
    droppedIterations: {
      k6: {
        count: pickNumber(k6Dropped, ['count']),
        ratePerSec: pickNumber(k6Dropped, ['rate']),
        source: 'k6 built-in dropped_iterations (authoritative at step level)',
      },
      derived: {
        plannedArrivals: round3(plannedReached),
        plannedArrivalsFullRun: round3(sumPlannedArrivals()),
        reachedBuckets: series.totals.reachedBuckets,
        startedArrivals: startedTotal,
        dropped: round3(derivedDropped),
        rate: plannedReached > 0 ? round3(derivedDropped / plannedReached) : null,
        source:
          'planned schedule integral over buckets the run reached, minus c0_iterations_started{bucket}',
      },
      thresholdPctMax: droppedPctMax,
      abortThreshold: 'dropped_iterations count<=per-bucket cumulative budget',
      byBucket: series.rows.map(function (row) {
        return {
          tag: row.tag,
          supervised: row.supervised,
          expected: row.expectedArrivals,
          started: row.started,
          dropped: row.dropped,
          rate: row.droppedRate,
          dropBudget: row.dropBudget,
        };
      }),
      note:
        'k6 dropped_iterations is the step-level number (count + rate); byBucket is the ' +
        'per-bucket arrival deficit, and dropBudget is the cumulative cap supervised live',
    },
    operations: operationSummary(data),
    take: {
      requested: takeRequested,
      used: take,
      cap: TAKE_CAP,
      capped: takeRequested > take,
    },
    vus: { preAllocated: preVus, max: maxVus },
    ids: { file: basename(idsFile), count: idsLoaded },
    appDbRttMs: appDbRttMeta,
    sampling: {
      schema: 'c0-sampling-contract/v1',
      purpose:
        'join external ingress / meta-plane / app-pool samples to this step without giving k6 cluster access',
      joinKeys: ['runId', 'step', 'bucket'],
      buckets: series.rows.map(function (row) {
        return {
          tag: row.tag,
          phase: row.phase,
          startEpochMs: row.startEpochMs,
          endEpochMs: row.endEpochMs,
        };
      }),
      requestTags: {
        header: 'x-c0-bucket',
        baggage: [
          'teable.loadtest.run_id',
          'teable.loadtest.scenario',
          'teable.loadtest.phase',
          'teable.loadtest.step',
          'teable.loadtest.bucket',
          'teable.loadtest.api',
        ],
      },
      externalEnv: {
        C0_RUN_ID: runId,
        C0_STEP_NAME: stepName,
        C0_WINDOW_FILE: metaPathFor(summaryPath),
        C0_BUCKET_SEC: supWindowSec,
        C0_STEP_START_EPOCH_MS: derivedStartMs,
        C0_STEP_END_EPOCH_MS: endedAtMs,
        C0_PLATEAU_START_EPOCH_MS: derivedStartMs + (warmupSec + rampSec) * 1000,
        C0_PLATEAU_END_EPOCH_MS: derivedStartMs + totalSec * 1000,
        C0_PHASE: 'warm|ramp|plateau',
      },
      ingress: {
        scope: 'ingress-nginx',
        cadenceSec: supWindowSec,
        joinOn: 'bucket start/end epochs',
        script: 'teableio/teable-infra/scripts/loadtest/samplers/cluster-sampler.sh',
        scriptEnvHint: 'OUT, C0_RUN_ID, C0_STEP_NAME, C0_BUCKET_SEC, C0_PHASE, DURATION_SEC',
      },
      metaPlane: {
        cadenceSec: supWindowSec,
        joinOn: 'bucket start/end epochs + run_id/step request tags',
      },
      appPool: {
        source: 'SigNoz pgx pool metrics (db.namespace, host.name, state)',
        cadenceSec: supWindowSec,
        joinOn: 'bucket grid + db.namespace',
        script: 'teableio/teable-infra/scripts/loadtest/samplers/db-sampler.sh',
      },
      note:
        'k6 never reads the cluster; fields here are the contract external samplers must use. ' +
        'Missing samples must be recorded as null, never 0.',
    },
    debug: debugFailRate > 0
      ? {
          failRate: debugFailRate,
          injectedFailures: pickNumber(valuesOf(data, 'c0_debug_injected_failures'), ['count']),
          localOnly: true,
          warning: 'DEBUG run: injected failures make this summary unusable as evidence',
        }
      : { failRate: 0 },
    summaryTrendStats: options.summaryTrendStats,
    thresholds: thresholds.results,
    thresholdsFailed: thresholds.failed,
    rawOutput: {
      path: rawOutPath || null,
      k6Flag: '--out json=' + (rawOutPath || '<path>'),
      requiredForExactQuantiles: true,
      note:
        'retain this NDJSON with the summary; k6-summary.mjs uses it for exact phase/op quantiles and failure/v2 breakdowns',
    },
  };

  var out = {};
  out[summaryPath] = JSON.stringify(data, null, 2);
  out[metaPathFor(summaryPath)] = JSON.stringify(meta, null, 2);
  return out;
}
