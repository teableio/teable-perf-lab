import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { cpus, release, tmpdir, totalmem } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalJson } from '../../case/canonicalJson';
import { parseBenchCaseManifest } from '../../case/manifest';
import { enumerateScenarioCatalogue } from '../../catalogue/enumerate';
import { materializeCatalogueScenario } from '../../catalogue/materialize';
import { runCase } from '../../runner/BenchRunner';
import { mergeReportSuiteReceipts, type ReportSuiteReceipt } from '../coverage';
import { exportTeaBenchReportRows } from '../exportTeable';
import { createTeaBenchReportFromRun } from '../fromBenchRun';
import { renderTeaBenchReportMarkdown } from '../renderMarkdown';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '../../..');
const smokeRuleId = 'R-FORMULA-001';

export async function generateObservedSmoke(outputDir: string): Promise<void> {
  if (!outputDir) throw new Error('An explicit private output directory is required');
  const outputRoot = await realpath(resolve(outputDir));
  if (!(await stat(outputRoot)).isDirectory()) {
    throw new Error('The private output path must be an existing directory');
  }
  const checkoutRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: packageRoot,
    encoding: 'utf8',
  }).trim();
  for (const sourceRoot of [checkoutRoot, packageRoot]) {
    const fromSource = relative(await realpath(sourceRoot), outputRoot);
    if (
      fromSource === '' ||
      (!isAbsolute(fromSource) && fromSource !== '..' && !fromSource.startsWith(`..${sep}`))
    ) {
      throw new Error('Observed smoke output must be outside the source checkout');
    }
  }
  const outputBase = join(outputRoot, 'observed-smoke');
  const cpuInfo = cpus();
  const gitSha = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: packageRoot,
    encoding: 'utf8',
  }).trim();
  const gitStatus = execFileSync('git', ['status', '--porcelain'], {
    cwd: packageRoot,
    encoding: 'utf8',
  });
  const commitDirty = gitStatus.trim().length > 0;
  const gitDiffHash = createHash('sha256')
    .update(
      execFileSync('git', ['diff', '--no-ext-diff', '--binary', 'HEAD'], {
        cwd: packageRoot,
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
      })
    )
    .digest('hex');
  const scenarios = enumerateScenarioCatalogue({ maxMillis: 10_000 }).scenarios;
  const scenario = scenarios.find((candidate) => candidate.ruleId === smokeRuleId);
  if (!scenario) throw new Error(`${smokeRuleId} is missing from the catalogue registry`);
  if (!scenario.applicability.applicable || scenario.executionStatus !== 'planned') {
    throw new Error(`${smokeRuleId} is not an executable catalogue scenario`);
  }
  const fullRegistry = scenarios.map((candidate) => candidate.scenarioId);
  const temporary = await mkdtemp(join(tmpdir(), 'teable-headless-observed-smoke-'));
  try {
    const generated = await materializeCatalogueScenario({ scenario, outDir: temporary });
    if (generated.cases.length !== 1) {
      throw new Error(`${smokeRuleId} materialized ${generated.cases.length} cases instead of one`);
    }
    const generatedCase = generated.cases[0]!;
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(generatedCase.manifestPath, 'utf8'))
    );
    if (manifest.run.samples !== 3 || manifest.run.warmup !== 1) {
      throw new Error('The materialized smoke scenario must use samples=3 and warmup=1');
    }
    const declaredChecks = [
      ...manifest.workload.flatMap((step) => {
        if (step.kind !== 'checkpoint' && step.kind !== 'expect-error') return [];
        const baseCheckId =
          step.kind === 'checkpoint'
            ? step.check.checkId
            : (step.checkId ?? `${step.key}/expect-error`);
        const obligationIds =
          step.kind === 'checkpoint' ? step.check.obligationIds : (step.obligationIds ?? []);
        return Array.from({ length: manifest.run.samples }, (_, sampleIndex) => ({
          checkId:
            manifest.run.samples === 1 ? baseCheckId : `${baseCheckId}#sample-${sampleIndex}`,
          obligationIds,
        }));
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
        return base.flatMap((check) =>
          Array.from({ length: manifest.run.samples }, (_, sampleIndex) => ({
            checkId:
              manifest.run.samples === 1 ? check.checkId : `${check.checkId}#sample-${sampleIndex}`,
            obligationIds: check.obligationIds,
          }))
        );
      }),
    ];
    const requiredCheckIds = new Map(
      scenario.coverageObligationKeys.map((obligationId) => [
        obligationId,
        declaredChecks
          .filter((check) => check.obligationIds.includes(obligationId))
          .map((check) => check.checkId),
      ])
    );
    const run = await runCase({
      teaPath: generatedCase.teaPath,
      manifestPath: generatedCase.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 1,
      repetitions: 1,
    });
    if (run.commit !== gitSha) {
      throw new Error(`Runner commit ${run.commit} does not match captured commit ${gitSha}`);
    }
    const dataHash = manifest.dataset.dataHash;
    if (!dataHash || !/^[0-9a-f]{64}$/.test(dataHash)) {
      throw new Error('The materialized scenario has no factual dataset hash');
    }

    const actualCheckIds = new Set(run.oracle.checks.map((check) => check.checkId));
    const suiteReceipts: ReportSuiteReceipt[] = [
      {
        receiptId: `receipt_observed_smoke_${scenario.scenarioId}`,
        suiteId: 'suite_observed_smoke',
        scenarioId: scenario.scenarioId,
        executionRef: null,
        applicable: true,
        planned: true,
        execution: 'not-executed',
        reason: '等待报告适配器按实际 checkpoint/final receipts 映射执行与通过状态。',
        rules: {
          plannedCount: scenario.coverageObligationKeys.length,
          executedCount: 0,
          receipts: scenario.coverageObligationKeys.map((id) => {
            const checkIds = requiredCheckIds.get(id)!;
            const missingCheckIds = checkIds.filter((checkId) => !actualCheckIds.has(checkId));
            return {
              id,
              requiredCheckIds: checkIds,
              planned: true,
              executed: false,
              status: 'not-executed',
              reason:
                checkIds.length === 0
                  ? 'Manifest 未声明该 obligation 的 checkpoint/expect-error/final oracle。'
                  : missingCheckIds.length > 0
                    ? `缺少实际 oracle receipts：${missingCheckIds.join('、')}`
                    : '等待报告适配器核对全部实际 checkpoint/final receipts。',
            };
          }),
        },
        sources: { plannedCount: 0, executedCount: 0, receipts: [] },
        edges: { plannedCount: 0, executedCount: 0, receipts: [] },
      },
    ];

    const manifestBytes = await readFile(generatedCase.manifestPath);
    const teaBytes = await readFile(generatedCase.teaPath);
    const fixtureHash = createHash('sha256').update(teaBytes).digest('hex');
    const runJson = `${JSON.stringify(run, null, 2)}\n`;
    const runHash = createHash('sha256').update(runJson).digest('hex');
    if (run.caseId !== generatedCase.caseId) {
      throw new Error(
        `Runner case ${run.caseId} differs from materialized case ${generatedCase.caseId}`
      );
    }
    const scenarioMappingJson = `${canonicalJson({
      schema: 'tea-bench-scenario-mapping/1',
      catalogueScenarioId: scenario.scenarioId,
      materializedCaseId: generatedCase.caseId,
      ruleId: scenario.ruleId,
      runId: run.runId,
    })}\n`;
    const scenarioMappingHash = createHash('sha256').update(scenarioMappingJson).digest('hex');
    const pglitePackage = JSON.parse(
      await readFile(join(packageRoot, '../adapter-db-postgres-pglite/package.json'), 'utf8')
    ) as { dependencies: Record<string, string> };
    const benchPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      version: string;
    };
    const pgliteVersion = pglitePackage.dependencies['@electric-sql/pglite'];
    if (!pgliteVersion) throw new Error('PGlite package version is missing');
    let report = createTeaBenchReportFromRun(run, {
      scenarioId: scenario.scenarioId,
      mode: 'fresh',
      commitDirty,
      dataHash,
      fixtureHash,
      toolVersions: {
        ...Object.fromEntries(
          Object.entries(process.versions).flatMap(([name, version]) =>
            version === undefined ? [] : [[name, version] as const]
          )
        ),
        headlessBench: benchPackage.version,
        pglite: pgliteVersion,
      },
      backend: {
        kind: 'pglite',
        version: pgliteVersion,
        configuration: { dataDir: 'memory://' },
      },
      postgres:
        run.environment.pgVersion === undefined
          ? null
          : { version: run.environment.pgVersion, extensions: [] },
      host: {
        os: `${process.platform} ${release()}`,
        arch: process.arch,
        cpu: cpuInfo[0]?.model ?? 'unknown',
        logicalCpuCount: cpuInfo.length,
        memoryBytes: totalmem(),
      },
      reproducibility: {
        commands: [
          {
            label: '物化并执行 PGlite observed smoke',
            argv: [
              'bun',
              '--conditions=@teable/source',
              'src/report/fixtures/observedSmoke.ts',
              '--out-dir',
              outputRoot,
            ],
            cwd: '.',
          },
        ],
        environment: {
          TZ: process.env.TZ ?? 'unset',
          LANG: process.env.LANG ?? 'unset',
          ...(commitDirty ? { GIT_DIFF_SHA256: gitDiffHash } : {}),
        },
        inputs: [
          {
            path: 'src/catalogue/templates.ts',
            sha256: createHash('sha256')
              .update(await readFile(join(packageRoot, 'src/catalogue/templates.ts')))
              .digest('hex'),
          },
          {
            path: 'generated/case.manifest.json',
            sha256: createHash('sha256').update(manifestBytes).digest('hex'),
          },
          { path: 'generated/fixture.tea', sha256: fixtureHash },
        ],
      },
      scope: {
        title: `PGlite observed smoke：${smokeRuleId} ${scenario.title}`,
        description: '实际物化并执行一个目录场景；范围只包含本次选择。',
        registry: {
          kind: 'selected',
          scenarioIds: [scenario.scenarioId],
          scenarios: [
            {
              scenarioId: scenario.scenarioId,
              ruleId: scenario.ruleId,
              title: scenario.title,
              description: scenario.description,
              profile: scenario.profile,
              workload: scenario.workload,
              fixture: scenario.fixture,
              oracle: scenario.oracle,
              executionStatus: scenario.executionStatus,
            },
          ],
        },
        configured: {
          scenarioIds: [scenario.scenarioId],
          description: `${smokeRuleId}；实际 PGlite samples=3、warmup=1。`,
        },
        included: [smokeRuleId, 'PGlite', 'checkpoint 与 final oracle'],
        exclusions: [{ subject: 'network', reason: '生成与执行均不访问网络。' }],
      },
      suiteReceipts,
      dataset: {
        name: `${smokeRuleId}-observed-smoke`,
        description: '由实际 catalogue materializer 生成的配方数据，不是客户数据回放。',
        rowCounts: manifest.dataset.rows,
      },
      artifacts: [
        {
          artifactId: 'artifact_observed_smoke_run',
          kind: 'legacy-run-json',
          path: 'observed-smoke.run.json',
          sha256: runHash,
          mediaType: 'application/json',
        },
        {
          artifactId: 'artifact_observed_smoke_scenario_mapping',
          kind: 'catalogue-scenario-mapping',
          path: 'observed-smoke.scenario.json',
          sha256: scenarioMappingHash,
          mediaType: 'application/json',
        },
      ],
      performanceVerdict: 'not-compared',
      limitations: [
        `只执行 ${smokeRuleId}；其余 ${fullRegistry.length - 1} 个目录场景未执行。`,
        '仅 3 个测量样本且没有基线，不作性能回归或提升结论。',
        ...(run.environment.pgVersion === undefined
          ? ['PostgreSQL 版本缺失：PGlite runner 未返回 pgVersion，故 provenance.postgres=null。']
          : []),
      ],
      conclusions: [
        {
          conclusionId: 'conclusion_observed_smoke',
          kind: 'evidence-derived',
          statement: `${smokeRuleId} 已由实际 runner 执行；逐状态正确性以 checkpoint/final oracle receipts 为准。`,
          evidenceRefs: ['artifact_observed_smoke_run', 'artifact_observed_smoke_scenario_mapping'],
          confidence: 'high',
          limitations: ['单一目录场景不能外推为完整规则注册表覆盖。'],
        },
      ],
    });
    const configuredReceipt = report.catalogue.suiteReceipts.find(
      (receipt) => receipt.receiptId === `receipt_observed_smoke_${scenario.scenarioId}`
    );
    if (!configuredReceipt) throw new Error('Configured smoke suite receipt is missing');
    if (
      configuredReceipt.execution === 'pass' &&
      configuredReceipt.rules.receipts.some(
        (receipt) => !receipt.executed || receipt.status !== 'pass'
      )
    ) {
      report = {
        ...report,
        catalogue: mergeReportSuiteReceipts([
          report.catalogue.suiteReceipts.map((receipt) =>
            receipt.receiptId === configuredReceipt.receiptId
              ? {
                  ...receipt,
                  execution: 'fail' as const,
                  reason:
                    '必需 checkpoint/final oracle receipts 未全部执行并通过；覆盖不能标记为通过。',
                }
              : receipt
          ),
        ]),
      };
    }

    await Promise.all([
      writeFile(`${outputBase}.scenario.json`, scenarioMappingJson),
      writeFile(`${outputBase}.run.json`, runJson),
      writeFile(`${outputBase}.report.json`, `${canonicalJson(report)}\n`),
      writeFile(`${outputBase}.md`, `${renderTeaBenchReportMarkdown(report)}\n`),
      writeFile(
        `${outputBase}.rows.json`,
        `${JSON.stringify(exportTeaBenchReportRows(report), null, 2)}\n`
      ),
    ]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith('/observedSmoke.ts')) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--out-dir' || !args[1]) {
    throw new Error(
      'Usage: observedSmoke.ts --out-dir <existing-private-directory-outside-checkout>'
    );
  }
  await generateObservedSmoke(args[1]);
}
