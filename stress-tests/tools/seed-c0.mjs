#!/usr/bin/env node
// Bulk seeder for the C0 BYODB case. Writes through the public v1 record API so
// the app owns schema, undo/trash, computed bookkeeping, and plan enforcement
// (no direct DB writes).
//
// Write safety:
//   - Only HTTP 429 is retried, and only because a rate-limited request was not
//     processed. Retries are bounded and honor Retry-After (capped).
//   - Network errors/timeouts, 5xx, 408, and unexpected 2xx are AMBIGUOUS: the
//     batch may or may not have committed. They are never retried; the run stops
//     and the batch is recorded as ambiguous. This prevents duplicate writes.
//   - Every other non-2xx (including 402 plan/row cap) is a definitive failure:
//     no retry, stop immediately.
//   - Workers stop reserving new batches after the first fatal result; already
//     in-flight requests are allowed to finish so their outcome is not lost.
//
// Env:
//   BASE_URL, TOKEN, TABLE_ID, RUN_ID                 required
//   ROWS (1000000), START_INDEX (0), CONCURRENCY (8), BATCH (200)
//   IDS_OUT (/tmp/c0-ids.json), IDS_COUNT (2000)
//   TIMEOUT_MS (180000), MAX_429_RETRIES (6), RETRY_AFTER_CAP_MS (60000)
//
// Read API cap: record IDs are sampled with take=100 (never above).
//
// Outputs:
//   IDS_OUT                          JSON array of existing record ids, written
//                                    atomically and only when every requested row
//                                    was acknowledged with no ambiguity.
//   IDS_OUT.receipt.json             machine-readable receipt (always written,
//                                    including failures). Contains actual
//                                    start/end timestamps, acknowledged/
//                                    ambiguous/rejected counts, safe status/error
//                                    code buckets, row-count verification, and
//                                    id-sampling outcome. No messages, bodies,
//                                    tokens, or URLs are written.
//
// Exit codes:
//   0  all ROWS acknowledged, no ambiguity, row-count delta verified or
//      explicitly recorded as unverified, ids written
//   1  any rejected/ambiguous batch, row-count mismatch, id sampling failure,
//      or incomplete seed
//   2  configuration error
//
// A rerun after a partial seed can duplicate rows: resume from the receipt's
// acknowledged count only after checking row counts. Within a single process,
// no ambiguous write is ever retried.

import fs from 'node:fs';
import path from 'node:path';

const env = process.env;

function failConfig(message) {
  console.error(message);
  process.exit(2);
}

function required(name) {
  const value = env[name];
  if (value === undefined || value === '') failConfig(`${name} is required`);
  return value;
}

function intEnv(name, fallback, min, max) {
  const raw = env[name];
  const n = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    failConfig(`${name} must be an integer in [${min}, ${max}], got ${raw === undefined ? fallback : raw}`);
  }
  return n;
}

const baseUrl = (env.BASE_URL || '').replace(/\/+$/, '');
const token = required('TOKEN');
const tableId = required('TABLE_ID');
const runId = required('RUN_ID');
if (!baseUrl) failConfig('BASE_URL is required');
if (!/^https?:\/\//i.test(baseUrl)) failConfig('BASE_URL must start with http:// or https://');

const rows = intEnv('ROWS', 1000000, 1, 100000000);
const startIndex = intEnv('START_INDEX', 0, 0, 1000000000);
const concurrency = intEnv('CONCURRENCY', 8, 1, 64);
const batch = intEnv('BATCH', 200, 1, 1000);
const idsOut = env.IDS_OUT || '/tmp/c0-ids.json';
const idsCount = intEnv('IDS_COUNT', 2000, 1, 1000000);
const timeoutMs = intEnv('TIMEOUT_MS', 180000, 1000, 3600000);
const max429Retries = intEnv('MAX_429_RETRIES', 6, 0, 20);
const retryAfterCapMs = intEnv('RETRY_AFTER_CAP_MS', 60000, 0, 600000);
const IDS_PAGE = 100; // hard API cap for take/skip list reads

const total = startIndex + rows;
let next = startIndex;
let stopRequested = false;
let stopReason = '';
let stopDetail = null;
let retries429 = 0;

const counts = {
  acknowledged: 0,
  ambiguous: 0,
  rejected: 0,
};
const attemptStatusCounts = {};
const errorCodes = {};
const failures = [];
const startedAt = new Date();
const startedMs = Date.now();
let lastProgressMs = 0;

const statuses = ['open', 'pending', 'done'];
const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

function inc(obj, key) {
  const k = key === undefined || key === null || key === '' ? 'missing' : String(key);
  obj[k] = (obj[k] || 0) + 1;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeErrorCode(text) {
  try {
    const body = JSON.parse(text);
    if (body && typeof body.code === 'string' && /^[A-Za-z0-9_.:\/-]{1,80}$/.test(body.code)) {
      return body.code;
    }
  } catch {
    // non-JSON or truncated body: do not record it
  }
  return 'missing';
}

function safeErrorName(error) {
  if (!error) return 'unknown';
  if (error.name === 'TimeoutError') return 'timeout';
  if (error.name === 'AbortError') return 'aborted';
  if (error.name) return String(error.name).slice(0, 40);
  return 'network_error';
}

function makeBatch(from, count) {
  const records = [];
  for (let i = 0; i < count; i++) {
    const n = from + i;
    records.push({
      fields: {
        Name: `${runId}-${n}`,
        Qty: n % 1000,
        Price: ((n * 37) % 100000) / 100,
        Status: statuses[n % statuses.length],
      },
    });
  }
  return records;
}

function retryAfterMs(headerValue, attempt) {
  const fallback = Math.min(30000, 500 * Math.pow(2, attempt));
  if (!headerValue) return fallback;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(retryAfterCapMs, Math.round(seconds * 1000));
  }
  const at = Date.parse(headerValue);
  if (Number.isFinite(at)) {
    return Math.min(retryAfterCapMs, Math.max(0, at - Date.now()));
  }
  return fallback;
}

function recordFailure(kind, result, from, count) {
  if (failures.length < 20) {
    failures.push({
      from,
      count,
      kind,
      status: result.status === undefined ? null : result.status,
      code: result.code || 'missing',
      received: result.received,
      sent: result.sent,
    });
  }
}

async function post(records) {
  const url = `${baseUrl}/api/table/${encodeURIComponent(tableId)}/record`;
  const body = JSON.stringify({ fieldKeyType: 'name', typecast: true, records });

  for (let attempt = 0; attempt <= max429Retries; attempt++) {
    let res;
    try {
      res = await fetch(url, {
        redirect: 'manual',
        method: 'POST',
        headers,
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return { kind: 'ambiguous', status: 0, code: 'network_error', error: safeErrorName(error) };
    }

    inc(attemptStatusCounts, res.status);
    let text = '';
    let bodyReadFailed = false;
    try {
      text = await res.text();
    } catch {
      bodyReadFailed = true;
    }

    if (res.status === 200 || res.status === 201) {
      let parsed = null;
      if (!bodyReadFailed && text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
      }
      if (parsed && Array.isArray(parsed.records) && parsed.records.length !== records.length) {
        // The server acknowledged the batch but returned a different number of
        // records. Some may have committed; never retry, stop closed.
        return {
          kind: 'ambiguous',
          status: res.status,
          code: 'record_count_mismatch',
          received: parsed.records.length,
          sent: records.length,
        };
      }
      return { kind: 'ok', status: res.status };
    }

    const code = safeErrorCode(text);

    if (res.status === 429 && attempt < max429Retries) {
      // A rate-limited request was not processed; retrying it cannot duplicate
      // a successful write. Bound the wait so a bad Retry-After cannot hang.
      retries429++;
      await sleep(retryAfterMs(res.headers.get('retry-after'), attempt));
      continue;
    }

    if (res.status === 429) {
      return { kind: 'rejected', status: res.status, code: code === 'missing' ? 'rate_limit_exhausted' : code };
    }
    if (res.status === 408 || res.status >= 500) {
      return { kind: 'ambiguous', status: res.status, code };
    }
    if (res.status >= 200 && res.status < 300) {
      return { kind: 'ambiguous', status: res.status, code: 'unexpected_success_status' };
    }
    return { kind: 'rejected', status: res.status, code };
  }

  return { kind: 'rejected', status: 429, code: 'rate_limit_exhausted' };
}

function logProgress(force) {
  const now = Date.now();
  if (!force && now - lastProgressMs < 5000 && counts.acknowledged < rows) return;
  lastProgressMs = now;
  const attempted = counts.acknowledged + counts.ambiguous + counts.rejected;
  const rate = attempted / Math.max(0.001, (now - startedMs) / 1000);
  console.log(
    `seed ${attempted}/${rows} attempted, ack=${counts.acknowledged}, ambiguous=${counts.ambiguous}, ` +
      `rejected=${counts.rejected}, ${rate.toFixed(1)} rows/s, elapsed=${Math.round((now - startedMs) / 1000)}s`
  );
}

async function worker() {
  while (!stopRequested) {
    const from = next;
    if (from >= total) return;
    const count = Math.min(batch, total - from);
    next += count;

    let result;
    try {
      result = await post(makeBatch(from, count));
    } catch (error) {
      // An internal error after dispatch is treated as an unknown write outcome.
      result = {
        kind: 'ambiguous',
        status: 0,
        code: 'seed_internal_error',
        error: safeErrorName(error),
      };
    }

    if (result.kind === 'ok') {
      counts.acknowledged += count;
    } else if (result.kind === 'ambiguous') {
      counts.ambiguous += count;
      recordFailure('ambiguous', result, from, count);
      inc(errorCodes, result.code);
    } else {
      counts.rejected += count;
      recordFailure('rejected', result, from, count);
      inc(errorCodes, result.code);
    }

    if (result.kind !== 'ok') {
      stopRequested = true;
      if (!stopReason) {
        stopReason = result.kind;
        stopDetail = {
          from,
          count,
          status: result.status === undefined ? null : result.status,
          code: result.code || 'missing',
          error: result.error,
        };
        const label =
          `seed STOP batch from=${from} count=${count} kind=${result.kind} ` +
          `status=${result.status === undefined ? 'n/a' : result.status} code=${result.code || 'missing'}`;
        console.error(label);
        if (result.status === 402) {
          console.error(
            'seed 402: plan/row cap reached; no retry was attempted. Grant row capacity or seed fewer rows.'
          );
        } else if (result.kind === 'ambiguous') {
          console.error(
            'seed ambiguous write: the batch may have committed; no retry was attempted to avoid duplicates.'
          );
        }
      }
    }

    logProgress(false);
  }
}

async function readRowCount() {
  try {
    const res = await fetch(
      `${baseUrl}/api/table/${encodeURIComponent(tableId)}/aggregation/row-count`,
      {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      }
    );
    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        // ignore body
      }
      return { value: null, error: { status: res.status, code: safeErrorCode(text) } };
    }
    const body = await res.json();
    const value = body.rowCount ?? body.count;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return { value: null, error: { status: res.status, code: 'invalid_row_count_body' } };
    }
    return { value, error: null };
  } catch (error) {
    return { value: null, error: { status: 0, code: 'network_error', error: safeErrorName(error) } };
  }
}

async function sampleIds(rowCountAtSample) {
  const ids = [];
  const seen = new Set();
  let duplicates = 0;
  let skip = 0;

  while (ids.length < idsCount) {
    let res;
    try {
      res = await fetch(
        `${baseUrl}/api/table/${encodeURIComponent(tableId)}/record?take=${IDS_PAGE}&skip=${skip}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'manual',
        }
      );
    } catch (error) {
      throw new Error(`id sampling network error: ${safeErrorName(error)}`);
    }
    if (!res.ok) {
      let text = '';
      try {
        text = await res.text();
      } catch {
        // ignore body
      }
      throw new Error(`id sampling failed: status=${res.status} code=${safeErrorCode(text)}`);
    }
    const body = await res.json();
    if (!Array.isArray(body.records)) {
      throw new Error('id sampling failed: response has no records array');
    }
    if (body.records.length === 0) break;

    for (const record of body.records) {
      const id = record && record.id;
      if (typeof id !== 'string' || id.length === 0) {
        throw new Error('id sampling failed: record without a non-empty string id');
      }
      if (seen.has(id)) {
        duplicates++;
        continue;
      }
      seen.add(id);
      ids.push(id);
    }
    skip += body.records.length;
  }

  if (ids.length === 0) {
    throw new Error('id sampling produced zero ids');
  }
  if (ids.length < idsCount) {
    if (rowCountAtSample !== null && rowCountAtSample >= idsCount) {
      throw new Error(
        `id sampling shortfall: got ${ids.length}/${idsCount} ids while rowCount=${rowCountAtSample}`
      );
    }
    console.error(
      `id sampling shortfall: got ${ids.length}/${idsCount} ids (table rowCount=${rowCountAtSample === null ? 'unknown' : rowCountAtSample})`
    );
  }
  return { ids: ids.slice(0, idsCount), duplicates };
}

function writeAtomic(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, filePath);
}

async function main() {
  const before = await readRowCount();

  console.log(
    `seed start: runId=${runId} target=${rows} startIndex=${startIndex} batch=${batch} ` +
      `concurrency=${concurrency} rowCountBefore=${before.value === null ? 'unavailable' : before.value}`
  );

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  const unprocessed = Math.max(0, total - next);
  const after = await readRowCount();

  const expectedDelta = counts.acknowledged;
  let actualDelta = null;
  let rowCountVerified = false;
  let countMismatch = false;
  if (before.value !== null && after.value !== null) {
    actualDelta = after.value - before.value;
    rowCountVerified = actualDelta === expectedDelta;
    countMismatch = !rowCountVerified;
  }

  const complete =
    !stopRequested &&
    counts.acknowledged === rows &&
    counts.ambiguous === 0 &&
    counts.rejected === 0 &&
    unprocessed === 0;
  const duplicatesPossible =
    counts.ambiguous > 0 || (actualDelta !== null && actualDelta > expectedDelta);

  let idsResult = { ids: [], duplicates: 0 };
  let idsError = null;
  let idsWritten = 0;
  let idsStatus = 'skipped';
  if (complete && !countMismatch) {
    try {
      idsResult = await sampleIds(after.value);
      writeAtomic(idsOut, JSON.stringify(idsResult.ids));
      idsWritten = idsResult.ids.length;
      idsStatus = 'written';
    } catch (error) {
      idsError = String(error && error.message ? error.message : error).slice(0, 300);
      idsStatus = 'failed';
      console.error(`seed ids failed: ${idsError}`);
    }
  } else if (complete && countMismatch) {
    idsStatus = 'skipped_row_count_mismatch';
  } else {
    idsStatus = 'skipped_seed_incomplete';
  }

  const endedAt = new Date();
  const elapsedSec = Number(((endedAt.getTime() - startedMs) / 1000).toFixed(1));
  const succeeded =
    complete && !countMismatch && idsStatus === 'written' && idsResult.ids.length > 0;


  let idsInvalidated = false;
  if (!succeeded) {
    try {
      // Fail closed: a stale id file from an earlier seed must not silently
      // drive the load test after an incomplete/ambiguous seed.
      writeAtomic(idsOut, '[]');
      idsInvalidated = true;
    } catch (error) {
      console.error(
        `seed could not invalidate stale ids file: ${String(
          error && error.message ? error.message : error
        ).slice(0, 200)}`
      );
    }
  }
  const receipt = {
    schema: 'c0-seed-receipt/v2',
    runId,
    tableId,
    rows,
    startIndex,
    batch,
    concurrency,
    idsPage: IDS_PAGE,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    elapsedSec,
    complete,
    succeeded,
    status: succeeded
      ? rowCountVerified
        ? 'success'
        : 'success_row_count_unverified'
      : countMismatch
        ? 'row_count_mismatch'
        : idsStatus === 'failed'
          ? 'ids_failed'
          : 'incomplete',
    stopRequested,
    stopReason,
    stopDetail,
    retries429,
    attemptedRows: counts.acknowledged + counts.ambiguous + counts.rejected,
    acknowledgedRows: counts.acknowledged,
    ambiguousRows: counts.ambiguous,
    rejectedRows: counts.rejected,
    unprocessedRows: unprocessed,
    duplicatesPossible,
    attemptStatusCounts,
    errorCodes,
    failures,
    rowCountBefore: before.value,
    rowCountAfter: after.value,
    rowCountErrors: { before: before.error, after: after.error },
    rowCountExpectedDelta: expectedDelta,
    rowCountActualDelta: actualDelta,
    rowCountVerified,
    rowCountMismatch: countMismatch,
    idsRequested: idsCount,
    idsWritten,
    idsDuplicateRemoved: idsResult.duplicates,
    idsStatus,
    idsError,
    idsFile: idsOut,
    idsInvalidated,
  };

  writeAtomic(`${idsOut}.receipt.json`, JSON.stringify(receipt, null, 2) + '\n');

  console.log(
    JSON.stringify({
      complete,
      succeeded,
      status: receipt.status,
      acknowledgedRows: counts.acknowledged,
      ambiguousRows: counts.ambiguous,
      rejectedRows: counts.rejected,
      unprocessedRows: unprocessed,
      rowCountBefore: before.value,
      rowCountAfter: after.value,
      rowCountVerified,
      idsWritten,
      idsStatus,
      stopReason,
    })
  );

  if (!succeeded) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`seed fatal: ${String(error && error.message ? error.message : error).slice(0, 300)}`);
  process.exitCode = 1;
});
