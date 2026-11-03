import { fileURLToPath } from 'node:url';

import { runCiBench } from './ci/ciRunner';

const connectionString = process.env.PRISMA_DATABASE_URL;
if (!connectionString) throw new Error('PRISMA_DATABASE_URL is required for the CI benchmark');

const integerFromEnv = (name: string): number | undefined => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
};

const calibrateHeadroom = process.env.TEABLE_BENCH_CALIBRATE;
const calibration =
  calibrateHeadroom === undefined || calibrateHeadroom === ''
    ? undefined
    : {
        headroom: Number(calibrateHeadroom),
        source:
          process.env.TEABLE_BENCH_CALIBRATE_SOURCE ??
          `calibrated from ${process.env.TEABLE_BENCH_SAMPLES ?? '20'} PostgreSQL samples`,
      };
if (calibration && (!Number.isFinite(calibration.headroom) || calibration.headroom < 1)) {
  throw new Error('TEABLE_BENCH_CALIBRATE must be a finite headroom multiplier of at least 1');
}
const families = (process.env.TEABLE_BENCH_FAMILIES ?? '')
  .split(',')
  .map((family) => family.trim())
  .filter((family) => family.length > 0);
const samples = integerFromEnv('TEABLE_BENCH_SAMPLES');
const maxCases = integerFromEnv('TEABLE_BENCH_MAX_CASES');

void runCiBench({
  outDir: process.env.TEABLE_BENCH_OUT_DIR ?? '/tmp/teable-headless-bench',
  connectionString,
  budgetsPath:
    process.env.TEABLE_BENCH_BUDGETS ??
    fileURLToPath(new URL('../budgets/catalogue.budgets.json', import.meta.url)),
  ...(samples === undefined ? {} : { samples }),
  ...(maxCases === undefined ? {} : { maxCases }),
  ...(families.length === 0 ? {} : { families }),
  ...(calibration === undefined ? {} : { calibrate: calibration }),
}).then((summary) => {
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  const passed =
    calibration === undefined
      ? summary.verdict === 'pass'
      : summary.cases.length > 0 &&
        summary.cases.every((entry) => entry.correctnessVerdict === 'pass');
  if (!passed) process.exitCode = 1;
});
