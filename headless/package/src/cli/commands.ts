import { Command } from '@effect/cli';
import { Effect } from 'effect';

import { BenchError } from '../errors';
import { invocationPath, jsonLine } from './io';
import {
  baselineOption,
  backendOption,
  candidateOption,
  caseOption,
  connectionOption,
  evidenceOption,
  evidenceInputOption,
  impactOption,
  impactInputOption,
  inputOption,
  markdownOption,
  maxCasesOption,
  maxMillisOption,
  maxRowsOption,
  maxSearchStatesOption,
  outOption,
  repetitionsOption,
  requiredTeaOption,
  runOption,
  samplesOption,
  specOption,
  scenarioOption,
  teaOption,
  warmupOption,
} from './options';
import type { BenchCliHandlers, BenchCliIo } from './types';

export type BenchCliState = { exitCode: 0 | 1 };

export type BenchCliDeps = {
  readonly io: BenchCliIo;
  readonly handlers: BenchCliHandlers;
  readonly setExitCode: (exitCode: 0 | 1) => void;
};

const fromPromise = <A>(tryPromise: () => Promise<A>): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: tryPromise, catch: (cause) => cause });

const integerAtLeast = (
  name: string,
  value: number | undefined,
  minimum: number
): Effect.Effect<void, BenchError> =>
  value === undefined || value >= minimum
    ? Effect.void
    : Effect.fail(
        new BenchError(
          'bench.cli.argument_invalid',
          `--${name} must be an integer greater than or equal to ${minimum}`
        )
      );

const generateCommand = (deps: BenchCliDeps) =>
  Command.make('generate', { spec: specOption, out: outOption }, ({ spec, out }) =>
    fromPromise(() =>
      deps.handlers.generate({ specPath: invocationPath(spec), outDir: invocationPath(out) })
    ).pipe(
      Effect.map((result) =>
        deps.io.stdout(
          jsonLine({ ok: true, data: { cases: result.cases, coverage: result.coverage } })
        )
      )
    )
  ).pipe(Command.withDescription('Generate pairwise benchmark cases'));

const deriveCommand = (deps: BenchCliDeps) =>
  Command.make(
    'derive',
    {
      tea: requiredTeaOption,
      out: outOption,
      maxCases: maxCasesOption,
      maxRows: maxRowsOption,
    },
    ({ tea, out, maxCases, maxRows }) =>
      Effect.gen(function* () {
        yield* integerAtLeast('max-cases', maxCases, 1);
        yield* integerAtLeast('max-rows', maxRows, 1);
        const result = yield* fromPromise(() =>
          deps.handlers.derive({
            teaPath: invocationPath(tea),
            outDir: invocationPath(out),
            maxCases,
            maxRows,
          })
        );
        deps.io.stdout(
          jsonLine({
            ok: true,
            data: { cases: result.cases, coverage: result.coverage, schema: result.schema },
          })
        );
      })
  ).pipe(Command.withDescription('Derive benchmark cases from a Teable archive schema'));

const runCommand = (deps: BenchCliDeps) =>
  Command.make(
    'run',
    {
      case: caseOption,
      tea: teaOption,
      backend: backendOption,
      connection: connectionOption,
      samples: samplesOption,
      warmup: warmupOption,
      repetitions: repetitionsOption,
      out: outOption,
      evidence: evidenceOption,
      evidenceInput: evidenceInputOption,
      impact: impactOption,
    },
    ({
      case: casePath,
      tea,
      backend,
      connection,
      samples,
      warmup,
      repetitions,
      out,
      evidence,
      evidenceInput,
      impact,
    }) =>
      Effect.gen(function* () {
        if (evidence === undefined && evidenceInput !== undefined) {
          return yield* Effect.fail(
            new BenchError('bench.cli.argument_invalid', '--evidence-input requires --evidence')
          );
        }
        if (impact !== undefined && evidence === undefined) {
          return yield* Effect.fail(
            new BenchError('bench.cli.argument_invalid', '--impact requires --evidence')
          );
        }
        yield* integerAtLeast('samples', samples, 1);
        yield* integerAtLeast('warmup', warmup, 0);
        yield* integerAtLeast('repetitions', repetitions, 1);
        const outPath = invocationPath(out);
        const impactPath = impact === undefined ? undefined : invocationPath(impact);
        const report = yield* fromPromise(() =>
          deps.handlers.run({
            casePath: invocationPath(casePath),
            tea,
            backend,
            connection,
            samples,
            warmup,
            repetitions,
            outPath,
            evidencePath: evidence === undefined ? undefined : invocationPath(evidence),
            evidenceInputPath:
              evidenceInput === undefined ? undefined : invocationPath(evidenceInput),
            impactPath,
          })
        );
        deps.io.stdout(
          jsonLine({
            ok: true,
            data: {
              runId: report.runId,
              caseId: report.caseId,
              performanceVerdict: report.performanceVerdict,
              performanceScore: report.performance?.score ?? null,
              caseP95Ms: report.performance?.case.observedP95Ms ?? null,
              correctnessVerdict: report.correctnessVerdict ?? report.verdict,
              verdict: report.verdict,
              ...(impactPath === undefined
                ? {}
                : { impact: impactPath, impactRows: `${impactPath}.rows.json` }),
            },
          })
        );
        if (report.verdict === 'fail' || report.performanceVerdict === 'fail') deps.setExitCode(1);
      })
  ).pipe(Command.withDescription('Run a generated benchmark case'));

const compareCommand = (deps: BenchCliDeps) =>
  Command.make(
    'compare',
    {
      baseline: baselineOption,
      candidate: candidateOption,
      out: outOption,
    },
    ({ baseline, candidate, out }) =>
      Effect.gen(function* () {
        const outPath = invocationPath(out);
        const report = yield* fromPromise(() =>
          deps.handlers.compare({
            baselinePath: invocationPath(baseline),
            candidatePath: invocationPath(candidate),
            outPath,
          })
        );
        deps.io.stdout(jsonLine(report));
        if (report.verdict === 'fail') deps.setExitCode(1);
      })
  ).pipe(Command.withDescription('Compare two independent benchmark run reports descriptively'));

const verifyCommand = (deps: BenchCliDeps) =>
  Command.make('verify', { run: runOption }, ({ run }) =>
    fromPromise(() => deps.handlers.verify({ runPath: invocationPath(run) })).pipe(
      Effect.map((report) => {
        deps.io.stdout(
          jsonLine({
            ok: true,
            data: {
              runId: report.runId,
              caseId: report.caseId,
              oracleStatus: report.oracle.status,
              performanceVerdict: report.performanceVerdict,
              correctnessVerdict: report.correctnessVerdict ?? report.verdict,
              verdict: report.verdict,
            },
          })
        );
        if (report.verdict !== 'pass') deps.setExitCode(1);
      })
    )
  ).pipe(Command.withDescription('Verify an existing benchmark run report'));

const catalogueEnumerateCommand = (deps: BenchCliDeps) =>
  Command.make(
    'enumerate',
    {
      out: outOption,
      markdown: markdownOption,
      maxCases: maxCasesOption,
      maxSearchStates: maxSearchStatesOption,
      maxMillis: maxMillisOption,
    },
    ({ out, markdown, maxCases, maxSearchStates, maxMillis }) =>
      Effect.gen(function* () {
        yield* integerAtLeast('max-cases', maxCases, 1);
        yield* integerAtLeast('max-search-states', maxSearchStates, 1);
        yield* integerAtLeast('max-millis', maxMillis, 1);
        const outPath = invocationPath(out);
        const markdownPath = invocationPath(markdown);
        const result = yield* fromPromise(() =>
          deps.handlers.catalogueEnumerate({
            outPath,
            markdownPath,
            maxCases,
            maxSearchStates,
            maxMillis,
          })
        );
        const { receipt, scenarios } = result.catalogue;
        deps.io.stdout(
          jsonLine({
            ok: true,
            data: {
              out: outPath,
              markdown: markdownPath,
              counts: {
                scenarios: scenarios.length,
                requested: receipt.requested,
                applicable: receipt.applicable,
                planned: receipt.planned,
                executed: receipt.executed,
                pass: receipt.pass,
                fail: receipt.fail,
                skipped: receipt.skipped,
                unsupported: receipt.unsupported,
              },
              familyCounts: result.familyCounts,
            },
          })
        );
      })
  ).pipe(Command.withDescription('Enumerate the validated scenario catalogue'));

const catalogueMaterializeCommand = (deps: BenchCliDeps) =>
  Command.make('materialize', { scenario: scenarioOption, out: outOption }, ({ scenario, out }) => {
    const outDir = invocationPath(out);
    return fromPromise(() =>
      deps.handlers.catalogueMaterialize({ scenarioId: scenario, outDir })
    ).pipe(
      Effect.map((result) =>
        deps.io.stdout(
          jsonLine({
            ok: true,
            data: {
              scenarioId: result.scenarioId,
              ruleId: result.ruleId,
              out: outDir,
              cases: result.cases,
              coverage: result.coverage,
            },
          })
        )
      )
    );
  }).pipe(Command.withDescription('Materialize one exact catalogue scenario'));

const catalogueCommand = (deps: BenchCliDeps) =>
  Command.make('catalogue').pipe(
    Command.withDescription('Manage the benchmark scenario catalogue'),
    Command.withSubcommands([catalogueEnumerateCommand(deps), catalogueMaterializeCommand(deps)])
  );

const reportRenderCommand = (deps: BenchCliDeps) =>
  Command.make('render', { input: inputOption, out: outOption }, ({ input, out }) => {
    const inputPath = invocationPath(input);
    const outPath = invocationPath(out);
    return fromPromise(() => deps.handlers.reportRender({ inputPath, outPath })).pipe(
      Effect.map(({ report }) =>
        deps.io.stdout(
          jsonLine({
            ok: true,
            data: { input: inputPath, out: outPath, schema: report.schema },
          })
        )
      )
    );
  }).pipe(Command.withDescription('Render a canonical v2 report as Chinese Markdown'));

const reportRenderHtmlCommand = (deps: BenchCliDeps) =>
  Command.make(
    'render-html',
    { input: inputOption, impact: impactInputOption, out: outOption },
    ({ input, impact, out }) => {
      const inputPath = invocationPath(input);
      const impactPath = impact === undefined ? undefined : invocationPath(impact);
      const outPath = invocationPath(out);
      return fromPromise(() =>
        deps.handlers.reportRenderHtml({ inputPath, impactPath, outPath })
      ).pipe(
        Effect.map(({ report }) =>
          deps.io.stdout(
            jsonLine({
              ok: true,
              data: {
                input: inputPath,
                ...(impactPath === undefined ? {} : { impact: impactPath }),
                out: outPath,
                schema: report.schema,
              },
            })
          )
        )
      );
    }
  ).pipe(Command.withDescription('Render a canonical v2 report as standalone Chinese HTML'));

const reportExportTeableCommand = (deps: BenchCliDeps) =>
  Command.make('export-teable', { input: inputOption, out: outOption }, ({ input, out }) => {
    const inputPath = invocationPath(input);
    const outPath = invocationPath(out);
    return fromPromise(() => deps.handlers.reportExportTeable({ inputPath, outPath })).pipe(
      Effect.map(({ report, rows }) =>
        deps.io.stdout(
          jsonLine({
            ok: true,
            data: {
              input: inputPath,
              out: outPath,
              schema: report.schema,
              counts: {
                scenarios: rows.scenarioRows.length,
                runs: rows.runRows.length,
                operations: rows.operationRows.length,
                correctness: rows.correctnessRows.length,
                artifacts: rows.artifactRows.length,
              },
            },
          })
        )
      )
    );
  }).pipe(Command.withDescription('Export canonical v2 report rows for offline Teable import'));

const reportCommand = (deps: BenchCliDeps) =>
  Command.make('report').pipe(
    Command.withDescription('Render and export canonical v2 reports'),
    Command.withSubcommands([
      reportRenderCommand(deps),
      reportRenderHtmlCommand(deps),
      reportExportTeableCommand(deps),
    ])
  );

export const buildBenchCommand = (deps: BenchCliDeps) =>
  Command.make('bench').pipe(
    Command.withDescription('Teable v2 headless benchmark harness'),
    Command.withSubcommands([
      generateCommand(deps),
      deriveCommand(deps),
      runCommand(deps),
      compareCommand(deps),
      verifyCommand(deps),
      catalogueCommand(deps),
      reportCommand(deps),
    ])
  );
