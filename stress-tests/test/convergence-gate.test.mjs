import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CRITERIA,
  evaluateSample,
  evaluateStreak,
  normalizeSample,
  parsePollOutput,
  renderSql,
} from '../tools/convergence-gate.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const tool = fileURLToPath(new URL('../tools/convergence-gate.mjs', import.meta.url));

const clean = {
  backlog: 0,
  due: 0,
  active: 0,
  stale: 0,
  seedOrigin: 0,
  deadLetters: 0,
  oldestAgeMs: 0,
};

function runCli(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [tool, ...args], {
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

function printfCommand(sample) {
  return `printf '%s' '${JSON.stringify(sample)}'`;
}

test('normalizeSample accepts snake_case and camelCase', () => {
  assert.deepEqual(
    normalizeSample({
      backlog: '0',
      due_pending: 0,
      processing: 0,
      stale_active: 0,
      seed_origin: 0,
      dead_letters: 0,
      oldest_age_ms: '420',
    }),
    { ...clean, oldestAgeMs: 420 }
  );
  assert.deepEqual(
    normalizeSample({
      backlog: 0,
      due: 0,
      active: 0,
      stale: 0,
      seedOrigin: 0,
      deadLetters: 0,
      oldestAgeMs: 420,
    }),
    { ...clean, oldestAgeMs: 420 }
  );
});

test('normalizeSample rejects missing or negative values', () => {
  assert.throws(() => normalizeSample({ backlog: 0 }), /missing/);
  assert.throws(() => normalizeSample({ ...clean, backlog: -1 }), />= 0/);
  assert.throws(() => normalizeSample({ ...clean, backlog: Number.NaN }), /finite number/);
});

test('evaluateSample passes only a fully clean sample', () => {
  assert.equal(evaluateSample(clean).passed, true);
  for (const [key, value] of [
    ['backlog', 1],
    ['due', 1],
    ['active', 1],
    ['stale', 1],
    ['seedOrigin', 1],
    ['deadLetters', 1],
  ]) {
    const result = evaluateSample({ ...clean, [key]: value });
    assert.equal(result.passed, false, `${key} should fail`);
    assert.match(result.failures[0], new RegExp(`${key}=1>0`));
  }
});

test('oldest age is exclusive at 5s', () => {
  assert.equal(evaluateSample({ ...clean, oldestAgeMs: 4_999 }).passed, true);
  assert.equal(evaluateSample({ ...clean, oldestAgeMs: 5_000 }).passed, false);
});

test('evaluateStreak needs the full quiet window', () => {
  const samples = [0, 10_000, 20_000, 30_000, 40_000, 60_000, 70_000, 120_000].map((at) => ({
    at,
    sample: clean,
  }));
  const gate = evaluateStreak(samples, DEFAULT_CRITERIA);
  assert.equal(gate.converged, true);
  assert.equal(gate.streakMs, 120_000);
});

test('one failing poll resets the quiet window', () => {
  const samples = [
    { at: 0, sample: clean },
    { at: 60_000, sample: clean },
    { at: 70_000, sample: { ...clean, backlog: 3 } },
    { at: 180_000, sample: clean },
    { at: 190_000, sample: clean },
  ];
  const gate = evaluateStreak(samples, DEFAULT_CRITERIA);
  assert.equal(gate.converged, false);
  assert.equal(gate.streakMs, 10_000);
});

test('a failing tail never converges', () => {
  const samples = [
    { at: 0, sample: clean },
    { at: 120_000, sample: clean },
    { at: 125_000, sample: { ...clean, oldestAgeMs: 5_000 } },
  ];
  const gate = evaluateStreak(samples, DEFAULT_CRITERIA);
  assert.equal(gate.converged, false);
  assert.equal(gate.lastPassed, false);
});

test('no samples is not convergence', () => {
  const gate = evaluateStreak([], DEFAULT_CRITERIA);
  assert.equal(gate.converged, false);
  assert.deepEqual(gate.lastFailures, ['no samples']);
});

test('renderSql substitutes the lease and validates the schema', () => {
  const sql = renderSql('interval {{staleLeaseSeconds}}', { staleLeaseSeconds: 60 });
  assert.equal(sql, 'interval 60');
  assert.match(renderSql('SELECT 1', { schema: 'space_abc' }), /^SET search_path TO "space_abc";/);
  assert.throws(() => renderSql('SELECT 1', { schema: 'bad;drop' }), /invalid schema/);
});

test('parsePollOutput takes the last JSON object line', () => {
  assert.deepEqual(parsePollOutput('notice\n{"backlog":0}\n'), { backlog: 0 });
  assert.deepEqual(parsePollOutput('{"first":1}\n{"second":2}\n'), { second: 2 });
  assert.throws(() => parsePollOutput('not json'), /no JSON object/);
});

test('CLI exits 0 and writes a converged trail', async () => {
  const result = await runCli([
    '--psql',
    printfCommand({
      backlog: 0,
      due: 0,
      active: 0,
      stale: 0,
      seed_origin: 0,
      dead_letters: 0,
      oldest_age_ms: 120,
    }),
    '--sql',
    'SELECT 1',
    '--window-ms',
    '0',
  ]);
  assert.equal(result.code, 0, result.stderr);
  const trail = JSON.parse(result.stdout);
  assert.equal(trail.outcome, 'converged');
  assert.equal(trail.exitCode, 0);
  assert.equal(trail.samples.length, 1);
  assert.deepEqual(
    trail.backlogTrajectory.map(({ backlog, oldestAgeMs }) => ({ backlog, oldestAgeMs })),
    [{ backlog: 0, oldestAgeMs: 120 }]
  );
});

test('CLI exits 2 when the backlog never drains', async () => {
  const result = await runCli([
    '--psql',
    printfCommand({ ...clean, backlog: 42, oldest_age_ms: 30_000 }),
    '--sql',
    'SELECT 1',
    '--window-ms',
    '0',
    '--cap-ms',
    '60',
    '--interval-ms',
    '10',
  ]);
  assert.equal(result.code, 2);
  const trail = JSON.parse(result.stdout);
  assert.equal(trail.outcome, 'inconclusive');
  assert.equal(trail.exitCode, 2);
  assert.ok(trail.backlogTrajectory.length >= 1);
  assert.match(trail.error, /inconclusive after 60 ms/);
});

test('CLI exits 2 with a trail when the poll command fails', async () => {
  const result = await runCli([
    '--psql',
    'exit 7',
    '--sql',
    'SELECT 1',
    '--window-ms',
    '0',
    '--cap-ms',
    '30',
    '--interval-ms',
    '10',
  ]);
  assert.equal(result.code, 2);
  const trail = JSON.parse(result.stdout);
  assert.equal(trail.outcome, 'inconclusive');
  assert.match(trail.samples[0].error, /poll exited 7/);
});
