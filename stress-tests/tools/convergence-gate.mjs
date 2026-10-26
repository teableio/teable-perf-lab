#!/usr/bin/env node
/**
 * Convergence gate for BYODB computed-outbox backlog.
 *
 * A load step must not start while seed/computed work is still draining: a
 * backlog left by a 1M-row seed made a clean image look like a create-latency
 * regression (computed lock wait p95 1,395 ms vs 46.7 ms). This tool polls a
 * caller-supplied SQL statement through a caller-supplied psql command and
 * exits only after every poll in a quiet window satisfies the criteria.
 *
 * Exit codes:
 *   0  converged: the criteria held for the whole quiet window
 *   2  inconclusive: cap reached, poll failed, or the criteria never held
 *
 * Everything emitted on stdout is the JSON trail; progress goes to stderr.
 * No dependencies, Node 22+.
 *
 * Example:
 *   node stress-tests/tools/convergence-gate.mjs \
 *     --schema "$SPACE_SCHEMA" \
 *     --sql-file stress-tests/tools/sql/computed-outbox-convergence.sql \
 *     --psql 'psql "$BYODB_DSN" -X -q -A -t -v ON_ERROR_STOP=1' \
 *     --json-out /tmp/gate-before-load.json
 */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
export const TOOL_VERSION = 1;

export const DEFAULT_CRITERIA = Object.freeze({
  maxBacklog: 0,
  maxDue: 0,
  maxActive: 0,
  maxStale: 0,
  maxSeedOrigin: 0,
  maxDeadLetters: 0,
  oldestAgeMsMax: 5_000,
  quietWindowMs: 120_000,
});

const COUNT_FIELDS = [
  ['backlog', 'maxBacklog'],
  ['due', 'maxDue'],
  ['active', 'maxActive'],
  ['stale', 'maxStale'],
  ['seedOrigin', 'maxSeedOrigin'],
  ['deadLetters', 'maxDeadLetters'],
];

const SAMPLE_ALIASES = {
  backlog: ['backlog'],
  due: ['due', 'duePending', 'due_pending'],
  active: ['active', 'processing'],
  stale: ['stale', 'staleActive', 'stale_active'],
  seedOrigin: ['seedOrigin', 'seed_origin', 'seedOriginTasks', 'seed_origin_tasks'],
  deadLetters: ['deadLetters', 'dead_letters'],
  oldestAgeMs: ['oldestAgeMs', 'oldest_age_ms', 'oldest_ms'],
};

const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Map one raw poll payload (snake_case or camelCase) to the gate sample shape. */
export function normalizeSample(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('sample must be a JSON object');
  }
  const sample = {};
  const missing = [];
  for (const [key, aliases] of Object.entries(SAMPLE_ALIASES)) {
    const source = aliases.find((alias) => raw[alias] !== undefined);
    if (source === undefined) {
      missing.push(key);
      continue;
    }
    const value = raw[source];
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
      sample[key] = Number(value);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      sample[key] = value;
    } else {
      throw new Error(`${key} must be a finite number, got ${JSON.stringify(value)}`);
    }
    if (sample[key] < 0) throw new Error(`${key} must be >= 0, got ${sample[key]}`);
  }
  if (missing.length > 0) {
    throw new Error(`sample is missing ${missing.join(', ')}`);
  }
  return sample;
}

/** Criteria for a single poll. Oldest age is strict: 5,000 ms fails. */
export function evaluateSample(sample, criteria = DEFAULT_CRITERIA) {
  if (!sample) return { passed: false, failures: ['no sample'] };
  const failures = [];
  for (const [key, limitKey] of COUNT_FIELDS) {
    if (sample[key] > criteria[limitKey]) {
      failures.push(`${key}=${sample[key]}>${criteria[limitKey]}`);
    }
  }
  if (!(sample.oldestAgeMs < criteria.oldestAgeMsMax)) {
    failures.push(`oldestAgeMs=${sample.oldestAgeMs}>=${criteria.oldestAgeMsMax}`);
  }
  return { passed: failures.length === 0, failures };
}

/**
 * Streak evaluation over ordered samples `[{ at: <epoch ms>, sample }]`.
 * A failing sample resets the quiet window; convergence needs one unbroken
 * passing run whose duration is at least `criteria.quietWindowMs`.
 */
export function evaluateStreak(samples, criteria = DEFAULT_CRITERIA) {
  let quietStart = null;
  let quietStartAt = null;
  let lastResult = null;
  for (const item of samples) {
    const result = evaluateSample(item.sample, criteria);
    lastResult = result;
    if (result.passed) {
      if (quietStart === null) {
        quietStart = item.at;
        quietStartAt = item.at;
      }
    } else {
      quietStart = null;
      quietStartAt = null;
    }
  }
  const streakMs =
    quietStart === null ? 0 : Math.max(0, samples[samples.length - 1].at - quietStart);
  return {
    converged: quietStart !== null && streakMs >= criteria.quietWindowMs,
    streakMs,
    quietStartAt,
    lastPassed: lastResult ? lastResult.passed : false,
    lastFailures: lastResult ? lastResult.failures : ['no samples'],
  };
}

/** Render the SQL template placeholders owned by this tool. */
export function renderSql(sql, { staleLeaseSeconds = 120, schema } = {}) {
  let rendered = sql.replaceAll('{{staleLeaseSeconds}}', String(staleLeaseSeconds));
  if (schema !== undefined) {
    if (!SCHEMA_RE.test(schema)) throw new Error(`invalid schema identifier: ${schema}`);
    rendered = `SET search_path TO "${schema}";\n${rendered}`;
  }
  return rendered;
}

/** Pick the last non-empty output line that parses as a JSON object. */
export function parsePollOutput(stdout) {
  const lines = String(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith('{')) continue;
    try {
      const parsed = JSON.parse(lines[index]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {
      // keep looking upward
    }
  }
  throw new Error(`poll output has no JSON object line: ${JSON.stringify(stdout.slice(0, 200))}`);
}

function parseCount(value, name, { min }) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`--${name} must be an integer >= ${min}, got ${value}`);
  }
  return number;
}

export function parseArgs(argv) {
  const options = {
    sql: undefined,
    sqlFile: undefined,
    psql: process.env.CONVERGENCE_GATE_PSQL,
    schema: undefined,
    intervalMs: 5_000,
    windowMs: DEFAULT_CRITERIA.quietWindowMs,
    capMs: 900_000,
    oldestAgeMsMax: DEFAULT_CRITERIA.oldestAgeMsMax,
    staleLeaseSeconds: 120,
    jsonOut: undefined,
    pretty: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      index += 1;
      return value;
    };
    switch (arg) {
      case '--sql':
        options.sql = next();
        break;
      case '--sql-file':
        options.sqlFile = next();
        break;
      case '--psql':
        options.psql = next();
        break;
      case '--schema':
        options.schema = next();
        break;
      case '--interval-ms':
        options.intervalMs = parseCount(next(), 'interval-ms', { min: 1 });
        break;
      case '--window-ms':
        options.windowMs = parseCount(next(), 'window-ms', { min: 0 });
        break;
      case '--cap-ms':
        options.capMs = parseCount(next(), 'cap-ms', { min: 1 });
        break;
      case '--oldest-age-ms':
        options.oldestAgeMsMax = parseCount(next(), 'oldest-age-ms', { min: 1 });
        break;
      case '--stale-lease-seconds':
        options.staleLeaseSeconds = parseCount(next(), 'stale-lease-seconds', { min: 1 });
        break;
      case '--json-out':
        options.jsonOut = next();
        break;
      case '--pretty':
        options.pretty = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

const HELP = `convergence-gate — wait for computed-outbox convergence before a timed step

Usage:
  node stress-tests/tools/convergence-gate.mjs --psql '<psql command>' \\
    (--sql '<SELECT json_build_object(...)>' | --sql-file <path>) [options]

Options:
  --psql <cmd>              command that reads SQL on stdin and prints one JSON line
                            (default: $CONVERGENCE_GATE_PSQL)
  --sql <sql>               SQL text; must emit one JSON object (see sql/ file)
  --sql-file <path>         read the SQL from a file
  --schema <name>           prepend SET search_path TO "<name>"; (validated identifier)
  --interval-ms <n>         poll interval (default 5000)
  --window-ms <n>           quiet window that must stay clean (default 120000)
  --cap-ms <n>              give up after this long and exit 2 (default 900000)
  --oldest-age-ms <n>       maximum oldest due age, exclusive (default 5000)
  --stale-lease-seconds <n> substituted into {{staleLeaseSeconds}} (default 120)
  --json-out <path>         also write the trail to this file
  --pretty                  pretty-print the trail
  -h, --help                show this help

Exit codes: 0 converged, 2 inconclusive (cap, poll error, or criteria unmet).
`;

function runPoll(command, sql, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    // The poll command is operator-supplied and may rely on env expansion
    // (`psql "$BYODB_DSN" ...`). Run it through an explicit POSIX shell instead
    // of shell:true; this tool never feeds untrusted input into the command.
    const shell = process.env.SHELL || '/bin/sh';
    const child = spawn(shell, ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      resolve({ code: null, stdout, stderr, error: `poll timed out after ${timeoutMs} ms` });
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr, error: error.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    // A poll command may exit without reading stdin (e.g. `exit 7`). On Linux
    // that closes the pipe and surfaces EPIPE on stdin; the exit code is the
    // real signal, so swallow the write error instead of crashing the gate.
    child.stdin.on('error', () => {});
    child.stdin.end(sql);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function toIso(at) {
  return new Date(at).toISOString();
}

export async function runGate(options, { now = Date.now, poll = runPoll } = {}) {
  const criteria = Object.freeze({
    maxBacklog: 0,
    maxDue: 0,
    maxActive: 0,
    maxStale: 0,
    maxSeedOrigin: 0,
    maxDeadLetters: 0,
    oldestAgeMsMax: options.oldestAgeMsMax,
    quietWindowMs: options.windowMs,
  });
  const sql = options.sqlFile ? await readFile(options.sqlFile, 'utf8') : options.sql;
  if (!sql) throw new Error('provide --sql or --sql-file');
  if (!options.psql) throw new Error('provide --psql (or set CONVERGENCE_GATE_PSQL)');
  const renderedSql = renderSql(sql, {
    staleLeaseSeconds: options.staleLeaseSeconds,
    schema: options.schema,
  });

  const startedAt = now();
  const samples = [];
  const pollTimeoutMs = Math.max(options.intervalMs, 30_000);
  let gate = evaluateStreak([], criteria);
  let terminalError = null;

  for (;;) {
    const at = now();
    const elapsedMs = at - startedAt;
    let sample;
    let failures;
    let passed;
    let error = null;
    try {
      const output = await poll(options.psql, renderedSql, pollTimeoutMs);
      if (output.error) throw new Error(output.error);
      if (output.code !== 0) {
        const detail = (output.stderr || output.stdout || '').trim().slice(0, 500);
        throw new Error(`poll exited ${output.code}${detail ? `: ${detail}` : ''}`);
      }
      sample = normalizeSample(parsePollOutput(output.stdout));
      ({ passed, failures } = evaluateSample(sample, criteria));
    } catch (caught) {
      error = caught.message;
      sample = null;
      passed = false;
      failures = [`poll-error: ${error}`];
    }
    samples.push({ at, elapsedMs, sample, passed, failures, error });
    gate = evaluateStreak(samples, criteria);
    process.stderr.write(
      `[convergence-gate] +${(elapsedMs / 1000).toFixed(0)}s ` +
        `${passed ? 'pass' : `fail(${failures.join(',')})`} ` +
        `streak=${(gate.streakMs / 1000).toFixed(0)}s/${(options.windowMs / 1000).toFixed(0)}s\n`
    );
    if (gate.converged) break;
    if (now() - startedAt >= options.capMs) {
      terminalError = `inconclusive after ${options.capMs} ms: convergence window not met`;
      break;
    }
    await sleep(options.intervalMs);
  }

  const finishedAt = now();
  const trajectory = samples.map((entry) => ({
    elapsedMs: entry.elapsedMs,
    backlog: entry.sample ? entry.sample.backlog : null,
    due: entry.sample ? entry.sample.due : null,
    active: entry.sample ? entry.sample.active : null,
    stale: entry.sample ? entry.sample.stale : null,
    seedOrigin: entry.sample ? entry.sample.seedOrigin : null,
    deadLetters: entry.sample ? entry.sample.deadLetters : null,
    oldestAgeMs: entry.sample ? entry.sample.oldestAgeMs : null,
    passed: entry.passed,
    error: entry.error,
  }));

  return {
    tool: 'convergence-gate',
    version: TOOL_VERSION,
    outcome: gate.converged ? 'converged' : 'inconclusive',
    exitCode: gate.converged ? 0 : 2,
    error: terminalError,
    criteria: {
      maxBacklog: 0,
      maxDue: 0,
      maxActive: 0,
      maxStale: 0,
      maxSeedOrigin: 0,
      maxDeadLetters: 0,
      oldestAgeMsMax: options.oldestAgeMsMax,
      quietWindowMs: options.windowMs,
    },
    options: {
      intervalMs: options.intervalMs,
      capMs: options.capMs,
      staleLeaseSeconds: options.staleLeaseSeconds,
      schema: options.schema ?? null,
      sqlFile: options.sqlFile ?? null,
    },
    startedAt: toIso(startedAt),
    finishedAt: toIso(finishedAt),
    durationMs: finishedAt - startedAt,
    gate: {
      convergedAt: gate.converged ? toIso(finishedAt) : null,
      durationMs: finishedAt - startedAt,
      streakMs: gate.streakMs,
      quietStartAt: gate.quietStartAt === null ? null : toIso(gate.quietStartAt),
      polls: samples.length,
      lastFailures: gate.lastFailures,
    },
    backlogTrajectory: trajectory,
    samples: samples.map((entry, index) => ({
      index,
      at: toIso(entry.at),
      elapsedMs: entry.elapsedMs,
      sample: entry.sample,
      passed: entry.passed,
      failures: entry.failures,
      error: entry.error,
    })),
  };
}

async function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${HELP}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  let trail;
  try {
    trail = await runGate(options);
  } catch (error) {
    trail = {
      tool: 'convergence-gate',
      version: TOOL_VERSION,
      outcome: 'inconclusive',
      exitCode: 2,
      error: error.message,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      backlogTrajectory: [],
      samples: [],
    };
  }
  const body = `${JSON.stringify(trail, null, options.pretty ? 2 : 0)}\n`;
  process.stdout.write(body);
  if (options.jsonOut) await writeFile(options.jsonOut, body);
  process.exitCode = trail.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
