import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { writeComplexitySeriesReports } from './report';
import { calibrateComplexitySeries, gateComplexitySeries } from './runner';
import type { ComplexityCalibrationArtifact, ComplexityGateReport } from './types';

export const COMPLEXITY_SERIES_CLI_USAGE = {
  calibrate:
    'calibrate --connection-string <url> --out-dir <dir> --headroom <ratio> --source <artifact-source> --runner <runner-class> [--samples 20] [--json <path>] [--markdown <path>]',
  gate: 'gate --connection-string <url> --out-dir <dir> --runner <runner-class> --calibration <path> --calibration-sha256 <sha256> [--samples 20] [--json <path>] [--markdown <path>]',
} as const;

export type ComplexitySeriesCliEnvironment = Readonly<Record<string, string | undefined>>;

export type ComplexitySeriesCliConfig =
  | {
      readonly mode: 'calibrate';
      readonly input: Parameters<typeof calibrateComplexitySeries>[0];
      readonly jsonPath: string;
      readonly markdownPath: string;
    }
  | {
      readonly mode: 'gate';
      readonly input: Parameters<typeof gateComplexitySeries>[0];
      readonly jsonPath: string;
      readonly markdownPath: string;
    };

export type ComplexitySeriesCliResult = {
  readonly exitCode: 0 | 1 | 2;
  readonly report: ComplexityCalibrationArtifact | ComplexityGateReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
  /** Exact persisted calibration JSON digest, or the gate's observed artifact digest. */
  readonly calibrationSha256: string | null;
};

type FlagMap = ReadonlyMap<string, string>;

function parseFlags(argv: ReadonlyArray<string>): FlagMap {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (!token.startsWith('--')) throw new Error(`Unexpected complexity-series argument: ${token}`);
    const equals = token.indexOf('=');
    const name = equals < 0 ? token.slice(2) : token.slice(2, equals);
    const value = equals < 0 ? argv[index + 1] : token.slice(equals + 1);
    if (equals < 0) index += 1;
    if (!name || value === undefined || value.startsWith('--')) {
      throw new Error(`Missing value for --${name || token}`);
    }
    if (flags.has(name)) throw new Error(`Duplicate complexity-series flag: --${name}`);
    flags.set(name, value);
  }
  return flags;
}

function required(value: string | undefined, description: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing ${description}`);
  }
  return value;
}

function optionalNumber(value: string | undefined, description: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid ${description}: ${value}`);
  return parsed;
}

function calibrationSettings(
  flags: FlagMap,
  environment: ComplexitySeriesCliEnvironment
): Pick<Parameters<typeof calibrateComplexitySeries>[0], 'headroom' | 'provenance'> {
  const headroom = optionalNumber(flags.get('headroom'), '--headroom');
  if (headroom === undefined) throw new Error('Missing --headroom');
  return {
    headroom,
    provenance: {
      source: required(
        flags.get('source') ?? environment.TEA_BENCH_COMPLEXITY_SOURCE,
        '--source or TEA_BENCH_COMPLEXITY_SOURCE'
      ),
      runner: required(
        flags.get('runner') ?? environment.TEA_BENCH_COMPLEXITY_RUNNER,
        '--runner or TEA_BENCH_COMPLEXITY_RUNNER'
      ),
      calibratedAt:
        flags.get('calibrated-at') ??
        environment.TEA_BENCH_COMPLEXITY_CALIBRATED_AT ??
        new Date().toISOString(),
    },
  };
}

function validateModeFlags(mode: ComplexitySeriesCliConfig['mode'], flags: FlagMap): void {
  const allowedFlags = new Set([
    'connection-string',
    'out-dir',
    'samples',
    'json',
    'markdown',
    'runner',
    ...(mode === 'calibrate'
      ? ['headroom', 'source', 'calibrated-at']
      : ['calibration', 'calibration-sha256']),
  ]);
  for (const name of flags.keys()) {
    if (!allowedFlags.has(name)) throw new Error(`Unknown complexity-series flag: --${name}`);
  }
}

export function parseComplexitySeriesCliArgs(
  argv: ReadonlyArray<string>,
  environment: ComplexitySeriesCliEnvironment = process.env
): ComplexitySeriesCliConfig {
  const [mode, ...rest] = argv;
  if (mode !== 'calibrate' && mode !== 'gate') {
    throw new Error('Complexity series requires explicit `calibrate` or `gate` mode');
  }
  const flags = parseFlags(rest);
  validateModeFlags(mode, flags);
  const connectionString = required(
    flags.get('connection-string') ?? environment.DATABASE_URL,
    '--connection-string or DATABASE_URL'
  );
  const outDir =
    flags.get('out-dir') ??
    environment.TEA_BENCH_COMPLEXITY_OUT_DIR ??
    'artifacts/complexity-series';
  const jsonPath = flags.get('json') ?? join(outDir, `${mode}.json`);
  const markdownPath = flags.get('markdown') ?? join(outDir, `${mode}.md`);
  const samplesPerPoint = optionalNumber(flags.get('samples'), '--samples');

  if (mode === 'calibrate') {
    return {
      mode,
      input: {
        connectionString,
        outDir,
        ...calibrationSettings(flags, environment),
        ...(samplesPerPoint === undefined ? {} : { samplesPerPoint }),
      },
      jsonPath,
      markdownPath,
    };
  }

  return {
    mode,
    input: {
      connectionString,
      outDir,
      runner: required(
        flags.get('runner') ?? environment.TEA_BENCH_COMPLEXITY_RUNNER,
        '--runner or TEA_BENCH_COMPLEXITY_RUNNER'
      ),
      calibrationArtifactPath: required(
        flags.get('calibration') ?? environment.TEA_BENCH_COMPLEXITY_CALIBRATION_PATH,
        '--calibration or TEA_BENCH_COMPLEXITY_CALIBRATION_PATH'
      ),
      expectedCalibrationSha256: required(
        flags.get('calibration-sha256') ?? environment.TEA_BENCH_COMPLEXITY_CALIBRATION_SHA256,
        '--calibration-sha256 or TEA_BENCH_COMPLEXITY_CALIBRATION_SHA256'
      ),
      ...(samplesPerPoint === undefined ? {} : { samplesPerPoint }),
    },
    jsonPath,
    markdownPath,
  };
}

export async function runComplexitySeriesCli(
  argv: ReadonlyArray<string>,
  environment: ComplexitySeriesCliEnvironment = process.env
): Promise<ComplexitySeriesCliResult> {
  const config = parseComplexitySeriesCliArgs(argv, environment);
  const report =
    config.mode === 'calibrate'
      ? await calibrateComplexitySeries(config.input)
      : await gateComplexitySeries(config.input);
  await writeComplexitySeriesReports({
    report,
    jsonPath: config.jsonPath,
    markdownPath: config.markdownPath,
  });
  const calibrationSha256 =
    report.mode === 'calibrate'
      ? createHash('sha256')
          .update(await readFile(config.jsonPath))
          .digest('hex')
      : report.calibrationEvidence.sha256;
  return {
    exitCode: report.verdict === 'pass' ? 0 : report.verdict === 'fail' ? 1 : 2,
    report,
    jsonPath: config.jsonPath,
    markdownPath: config.markdownPath,
    calibrationSha256,
  };
}
