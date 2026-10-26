import http from 'k6/http';
import { check } from 'k6';
import { Trend, Counter } from 'k6/metrics';

export var opDuration = new Trend('teable_op_duration', true);
export var opFailures = new Counter('teable_op_failures');

function hex(length) {
  var out = '';
  var chars = '0123456789abcdef';
  for (var i = 0; i < length; i++) {
    out += chars.charAt(Math.floor(Math.random() * 16));
  }
  return out;
}

export function traceparent() {
  return '00-' + hex(32) + '-' + hex(16) + '-01';
}

export function requestHeaders(cfg, op) {
  return {
    Authorization: 'Bearer ' + cfg.token,
    'Content-Type': 'application/json',
    traceparent: traceparent(),
    baggage:
      'teable.loadtest.run_id=' +
      encodeURIComponent(cfg.runId) +
      ',teable.loadtest.scenario=' +
      encodeURIComponent(op) +
      ',teable.loadtest.api=' +
      encodeURIComponent(cfg.apiKind),
    'x-window-id': 'lt-' + cfg.runId + '-' + __VU + '-' + __ITER,
  };
}

export function isExpected(status, expected) {
  if (!expected) return status >= 200 && status < 300;
  if (Array.isArray(expected)) return expected.indexOf(status) >= 0;
  return status === expected;
}

export function doRequest(cfg, method, url, body, op, expected) {
  var params = {
    headers: requestHeaders(cfg, op),
    tags: { op: op, api: cfg.apiKind },
  };
  var payload = body === null || body === undefined ? null : JSON.stringify(body);
  var res = http.request(method, url, payload, params);
  opDuration.add(res.timings.duration, { op: op, api: cfg.apiKind });
  var ok = check(res, {
    ['status ' + op]: function (r) {
      return isExpected(r.status, expected);
    },
  });
  if (!ok) {
    opFailures.add(1, { op: op, api: cfg.apiKind, status: String(res.status) });
  }
  return res;
}

export function json(res) {
  try {
    return res.json();
  } catch (e) {
    return null;
  }
}

export function randomItem(items) {
  if (!items || items.length === 0) return '';
  return items[Math.floor(Math.random() * items.length)];
}

export function extractRecordId(res) {
  var body = json(res);
  if (!body) return '';
  if (body.id) return body.id;
  if (body.record && body.record.id) return body.record.id;
  if (body.records && body.records.length > 0 && body.records[0].id) return body.records[0].id;
  if (body.data && body.data.id) return body.data.id;
  if (body.data && body.data.records && body.data.records.length > 0) return body.data.records[0].id;
  return '';
}

export function valueFor(cfg) {
  return cfg.fieldValuePrefix + '-' + cfg.runId + '-' + __VU + '-' + __ITER + '-' + Date.now();
}
