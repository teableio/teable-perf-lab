import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256Hex } from '../case/canonicalJson';
import { computeDatasetHash, type BenchCaseManifest } from '../case/manifest';
import { enumerateScenarioCatalogue } from '../catalogue/enumerate';
import type { Scenario } from '../catalogue/schema';
import type { ReportSuiteReceipt } from '../report/coverage';
import type { CreateTeaBenchReportFromRunInput } from '../report/fromBenchRun';
import type { TeaBenchReport } from '../report/schema';
import type { BenchRunReport } from '../runner/BenchRunner';
import { readTeaArchive } from '../tea/teaZip';

export type EvidencePlan = Pick<CreateTeaBenchReportFromRunInput, 'scope' | 'suiteReceipts'>;
export type CapturedInvocation = {
  readonly dirty: boolean;
  readonly sourceHash: string;
  readonly fixtureHash: string;
  readonly manifestHash: string;
  readonly csvByEntry?: ReadonlyMap<string, string>;
  readonly executablePath?: string;
  readonly entrypointPath?: string;
  readonly cwd?: string;
  readonly host: CreateTeaBenchReportFromRunInput['host'];
};
export type DeclaredCheck = {
  readonly checkId: string;
  readonly obligationIds: ReadonlyArray<string>;
};

export async function captureInvocation(
  manifestPath: string,
  teaPath: string,
  dataMode: BenchCaseManifest['source']['dataMode']
): Promise<CapturedInvocation> {
  const status = execFileSync('git', ['status', '--porcelain=v2', '-z'], {
    maxBuffer: 128 * 1024 * 1024,
  });
  const unstaged = execFileSync('git', ['diff', '--no-ext-diff', '--binary'], {
    maxBuffer: 128 * 1024 * 1024,
  });
  const staged = execFileSync('git', ['diff', '--no-ext-diff', '--binary', '--cached'], {
    maxBuffer: 128 * 1024 * 1024,
  });
  const cpuInfo = cpus();
  const fixtureBytes = await readFile(teaPath);
  return {
    dirty: status.length > 0,
    sourceHash: sha256Hex(Buffer.concat([status, unstaged, staged])),
    fixtureHash: sha256Hex(fixtureBytes),
    manifestHash: sha256Hex(await readFile(manifestPath)),
    csvByEntry: dataMode === 'materialized' ? readTeaArchive(fixtureBytes).csvByEntry : undefined,
    executablePath: process.execPath,
    entrypointPath: process.argv[1] === undefined ? undefined : resolve(process.argv[1]),
    cwd: process.cwd(),
    host: {
      os: `${process.platform} ${release()}`,
      arch: process.arch,
      cpu: cpuInfo[0]?.model ?? '未采集 CPU 型号',
      logicalCpuCount: Math.max(1, cpuInfo.length),
      memoryBytes: totalmem(),
    },
  };
}

export function declaredChecks(
  manifest: BenchCaseManifest,
  samples: number,
  repetitions = 1
): ReadonlyArray<DeclaredCheck> {
  const scoped = (base: string, repetitionIndex: number, sampleIndex: number): string => {
    if (repetitions > 1) {
      return `${base}#repetition-${repetitionIndex}${samples > 1 ? `/sample-${sampleIndex}` : ''}`;
    }
    return samples === 1 ? base : `${base}#sample-${sampleIndex}`;
  };
  const expand = (base: string, obligationIds: ReadonlyArray<string>): DeclaredCheck[] =>
    Array.from({ length: repetitions }, (_, repetitionIndex) =>
      Array.from({ length: samples }, (_, sampleIndex) => ({
        checkId: scoped(base, repetitionIndex, sampleIndex),
        obligationIds,
      }))
    ).flat();
  return [
    ...manifest.workload.flatMap((step) => {
      if (step.kind !== 'checkpoint' && step.kind !== 'expect-error') return [];
      const checkId =
        step.kind === 'checkpoint'
          ? step.check.checkId
          : (step.checkId ?? `${step.key}/expect-error`);
      const obligationIds =
        step.kind === 'checkpoint' ? step.check.obligationIds : (step.obligationIds ?? []);
      return expand(checkId, obligationIds);
    }),
    ...manifest.oracle.flatMap((oracle) => {
      const base =
        oracle.kind === 'invariant'
          ? oracle.checks.map((check, index) => ({
              checkId: check.checkId ?? `${oracle.key}/${index + 1}/${check.type}`,
              obligationIds: check.obligationIds ?? [],
            }))
          : [
              {
                checkId: oracle.checkId ?? `${oracle.key}/${oracle.kind}`,
                obligationIds: oracle.obligationIds ?? [],
              },
            ];
      return base.flatMap((check) => expand(check.checkId, check.obligationIds));
    }),
  ];
}

function plannedReceipt(
  scenarioId: string,
  obligationIds: ReadonlyArray<string>,
  checks: ReadonlyArray<DeclaredCheck>
): ReportSuiteReceipt {
  const receipts = obligationIds.map((id) => ({
    id,
    requiredCheckIds: checks
      .filter((check) => check.obligationIds.includes(id))
      .map((check) => check.checkId),
    planned: true,
    executed: false,
    status: 'not-executed' as const,
    reason: '等待实际运行收据验证全部声明检查。',
  }));
  return {
    receiptId: `receipt_${scenarioId}`,
    suiteId: 'single-run',
    scenarioId,
    executionRef: null,
    applicable: true,
    planned: true,
    execution: 'not-executed',
    reason: '等待实际执行。',
    rules: { plannedCount: receipts.length, executedCount: 0, receipts },
    sources: { plannedCount: 0, executedCount: 0, receipts: [] },
    edges: { plannedCount: 0, executedCount: 0, receipts: [] },
  };
}

const scenarioMetadata = (scenario: Scenario) => ({
  scenarioId: scenario.scenarioId,
  ruleId: scenario.ruleId,
  title: scenario.title,
  description: scenario.description,
  profile: scenario.profile,
  workload: scenario.workload,
  fixture: scenario.fixture,
  oracle: scenario.oracle,
  executionStatus: scenario.executionStatus,
});

export function defaultEvidencePlan(
  manifest: BenchCaseManifest,
  samples: number,
  repetitions = 1
): EvidencePlan {
  const scenarios = enumerateScenarioCatalogue().scenarios;
  const stableScenarioId =
    typeof manifest.dimensions?.scenarioId === 'string'
      ? manifest.dimensions.scenarioId
      : manifest.caseId;
  const scenario = scenarios.find((candidate) => candidate.scenarioId === stableScenarioId);
  const checks = declaredChecks(manifest, samples, repetitions);
  const obligationIds = [...new Set(checks.flatMap((check) => check.obligationIds))];
  return {
    scope: {
      title: manifest.title,
      description: '从本次实际 manifest 和运行收据生成；范围只包含当前选择的场景。',
      registry: {
        kind: 'selected',
        scenarioIds: [stableScenarioId],
        scenarios: scenario === undefined ? [] : [scenarioMetadata(scenario)],
      },
      configured: {
        scenarioIds: [stableScenarioId],
        description: '仅运行指定 manifest。',
      },
      included: ['manifest 声明的操作序列和检查'],
      exclusions: [{ subject: '未声明行为', reason: '不声称穷举并发、认证、权限或任意公式程序。' }],
    },
    suiteReceipts: [plannedReceipt(stableScenarioId, obligationIds, checks)],
  };
}

function pgliteVersion(): string {
  const moduleRoot = dirname(fileURLToPath(import.meta.url));
  const packageRoots = [
    resolve(moduleRoot, '../package.json'),
    resolve(moduleRoot, '../../package.json'),
  ];
  const packagePath = packageRoots.find((candidate) => existsSync(candidate));
  if (!packagePath) throw new Error('Benchmark package metadata is unavailable');
  const parsed: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (parsed === null || typeof parsed !== 'object' || !('dependencies' in parsed)) {
    throw new Error('Benchmark package dependencies are missing');
  }
  const dependencies = parsed.dependencies;
  if (dependencies === null || typeof dependencies !== 'object') {
    throw new Error('Benchmark package dependencies are invalid');
  }
  if (!('@electric-sql/pglite' in dependencies)) {
    throw new Error('PGlite version is missing from the benchmark package');
  }
  const version = dependencies['@electric-sql/pglite'];
  if (typeof version !== 'string' || version.length === 0) {
    throw new Error('PGlite version is invalid');
  }
  return version;
}

function reproductionCommand(input: {
  run: BenchRunReport;
  captured: CapturedInvocation;
  outPath?: string;
}): CreateTeaBenchReportFromRunInput['reproducibility']['commands'][number] {
  const { run, captured } = input;
  return {
    label:
      run.backend === 'postgres'
        ? '设置 TEABLE_BENCH_CONNECTION 为同一 PostgreSQL 连接串后复现此运行'
        : '复现此 benchmark 运行',
    argv: [
      captured.executablePath ?? process.execPath,
      captured.entrypointPath ?? resolve(process.argv[1] ?? fileURLToPath(import.meta.url)),
      'run',
      '--case',
      resolve(run.manifestPath),
      '--tea',
      resolve(run.teaPath),
      '--backend',
      run.backend,
      '--samples',
      String(run.samples),
      '--warmup',
      String(run.warmup),
      '--repetitions',
      String(run.repetitions.length),
      '--out',
      resolve(input.outPath ?? resolve(dirname(run.manifestPath), 'reproduced-run.json')),
    ],
    cwd: captured.cwd ?? process.cwd(),
  };
}

function reproducibilityEvidence(input: {
  run: BenchRunReport;
  captured: CapturedInvocation;
  outPath?: string;
}): CreateTeaBenchReportFromRunInput['reproducibility'] {
  const { run, captured } = input;
  return {
    commands: [reproductionCommand(input)],
    environment: {
      GIT_WORKTREE_STATE_SHA256: captured.sourceHash,
      ...(run.backend === 'postgres'
        ? {
            TEABLE_BENCH_CONNECTION:
              'Set securely to the same PostgreSQL connection string used by the captured run.',
          }
        : {}),
    },
    inputs: [
      { path: resolve(run.manifestPath), sha256: captured.manifestHash },
      { path: resolve(run.teaPath), sha256: captured.fixtureHash },
    ],
  };
}

export function capturedEvidenceInput(input: {
  run: BenchRunReport;
  manifest: BenchCaseManifest;
  captured: CapturedInvocation;
  plan?: EvidencePlan;
  artifacts?: TeaBenchReport['executions'][number]['artifacts'];
  outPath?: string;
}): CreateTeaBenchReportFromRunInput {
  const { run, manifest, captured } = input;
  const plan = input.plan ?? defaultEvidencePlan(manifest, run.samples, run.repetitions.length);
  const version =
    run.backend === 'pglite' ? pgliteVersion() : (run.environment.pgVersion ?? '未采集；详见局限');
  const datasetHash = computeDatasetHash({
    dataMode: manifest.source.dataMode,
    rows: manifest.dataset.rows,
    seed: manifest.dataset.seed,
    recipe: manifest.dataset.recipe,
    csvByEntry: captured.csvByEntry,
  });
  return {
    ...plan,
    mode: 'fresh',
    scenarioId:
      plan.scope.configured.scenarioIds.length === 1
        ? plan.scope.configured.scenarioIds[0]
        : undefined,

    dataset: {
      name: manifest.title,
      description:
        manifest.source.dataMode === 'recipe'
          ? '确定性合成配方；行数为配方请求值。'
          : '原始 CSV 数据回放。',
      rowCounts: manifest.dataset.rows,
    },
    commitDirty: captured.dirty,
    commitDirtyReason: captured.dirty
      ? '运行前 git status --porcelain 非空；只保存差异哈希，不公开文件名。'
      : undefined,
    dataHash: datasetHash,
    fixtureHash: captured.fixtureHash,
    toolVersions: { node: process.version, runtime: run.environment.runtime, backend: version },
    backend: { kind: run.backend, version },
    postgres:
      run.environment.pgVersion === undefined
        ? null
        : { version: run.environment.pgVersion, extensions: [] },
    host: captured.host,
    reproducibility: reproducibilityEvidence({
      run,
      captured,
      ...(input.outPath ? { outPath: input.outPath } : {}),
    }),
    artifacts: input.artifacts ?? [],
    performanceVerdict: 'not-compared',
    limitations: [
      '没有基线比较，不给出性能通过结论。',
      ...(run.environment.pgVersion === undefined
        ? ['运行收据未采集 PostgreSQL 版本；postgres=null。']
        : []),
    ],
  };
}
