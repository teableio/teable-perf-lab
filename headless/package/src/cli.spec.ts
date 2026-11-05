import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { enumerateScenarioCatalogue } from './catalogue';
import { runBenchCli } from './cli';
import type { BenchCliHandlers, BenchCliIo } from './cli/types';
import { BenchError } from './errors';
import { exportTeaBenchReportRows } from './report/exportTeable';
import { deterministicTestReport } from './report/fixtures/deterministicReport';
import type { BenchRunReport } from './runner/BenchRunner';
import type { BenchCompareReport } from './runner/compare';

const report = (verdict: BenchRunReport['verdict']): BenchRunReport =>
  ({
    runId: 'run-1',
    caseId: 'case-1',
    verdict,
    oracle: { status: verdict === 'pass' ? 'pass' : 'not-run' },
  }) as BenchRunReport;

const comparison = (verdict: BenchCompareReport['verdict']): BenchCompareReport =>
  ({
    baselineRunId: 'base',
    candidateRunId: 'candidate',
    caseId: 'case-1',
    verdict,
  }) as BenchCompareReport;

const setup = (overrides: Partial<BenchCliHandlers> = {}) => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: BenchCliIo = {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  };
  const handlers: BenchCliHandlers = {
    generate: vi.fn(async () => ({
      cases: [],
      coverage: {
        totalPairs: 0,
        coveredPairs: 0,
        uncoveredPairs: [],
        receipt: {
          rawPairCountFormula: '0',
          rawPairCount: 0,
          completable: 0,
          nonCompletable: 0,
          unknown: 0,
          searchStates: 0,
          truncated: false,
          truncatedBy: [],
          unknownPairs: [],
          bounds: { maxSearchStates: 1, maxMillis: 1 },
          covered: 0,
        },
      },
    })),
    derive: vi.fn(async () => ({
      cases: [],
      coverage: {
        totalPairs: 0,
        coveredPairs: 0,
        uncoveredPairs: [],
        computedFields: [],
        obligations: [],
        receipt: {
          graph: {
            eligibleSources: 0,
            discoveredObligations: 0,
            searchStates: 0,
            truncated: false,
            truncatedBy: [],
            unknownSourceIds: [],
            bounds: { maxGraphStates: 1, maxMillis: 1 },
          },
          pairs: {
            rawPairCountFormula: '0',
            rawPairCount: 0,
            completable: 0,
            nonCompletable: 0,
            unknown: 0,
            searchStates: 0,
            truncated: false,
            truncatedBy: [],
            unknownPairs: [],
            bounds: { maxSearchStates: 1, maxMillis: 1 },
            covered: 0,
          },
          data: {
            requested: 'recipe' as const,
            selected: 'recipe' as const,
            provenance: 'schema-synthetic-recipe' as const,
            archiveCsvEntries: 0,
            gaps: [],
          },
          gaps: [],
        },
      },
      schema: { tables: 1, fields: 1, computedFields: 0, motifs: {} },
    })),
    run: vi.fn(async () => report('pass')),
    compare: vi.fn(async () => comparison('pass')),
    verify: vi.fn(async () => report('pass')),
    catalogueEnumerate: vi.fn(async () => ({
      catalogue: enumerateScenarioCatalogue(),
      familyCounts: {},
    })),
    catalogueMaterialize: vi.fn(async (input) => ({
      scenarioId: input.scenarioId,
      ruleId: 'R-QUERY-001',
      cases: [],
      coverage: {
        totalPairs: 0,
        coveredPairs: 0,
        uncoveredPairs: [],
        receipt: {
          rawPairCountFormula: '0',
          rawPairCount: 0,
          completable: 0,
          nonCompletable: 0,
          unknown: 0,
          searchStates: 0,
          truncated: false,
          truncatedBy: [],
          unknownPairs: [],
          bounds: { maxSearchStates: 1, maxMillis: 1 },
          covered: 0,
        },
      },
    })),
    reportRender: vi.fn(async () => ({ report: deterministicTestReport })),
    reportRenderHtml: vi.fn(async () => ({ report: deterministicTestReport })),
    reportExportTeable: vi.fn(async () => ({
      report: deterministicTestReport,
      rows: exportTeaBenchReportRows(deterministicTestReport),
    })),
    ...overrides,
  };
  return { stdout, stderr, io, handlers };
};

const envelopeCode = (line: string): string => {
  const parsed: unknown = JSON.parse(line);
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !('error' in parsed) ||
    parsed.error === null ||
    typeof parsed.error !== 'object' ||
    !('code' in parsed.error) ||
    typeof parsed.error.code !== 'string'
  ) {
    throw new Error('Expected CLI error envelope');
  }
  return parsed.error.code;
};

beforeEach(() => {
  vi.stubEnv('INIT_CWD', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runBenchCli', () => {
  it.each([
    [['run'], 'bench.cli.argument_invalid'],
    [['generate', '--out', 'generated'], 'bench.cli.argument_invalid'],
    [['derive', '--out', 'generated'], 'bench.cli.argument_invalid'],
    [['derive', '--tea', 'schema.tea'], 'bench.cli.argument_invalid'],
    [['run', '--case', 'case.json'], 'bench.cli.argument_invalid'],
    [['unknown'], 'bench.cli.command_unknown'],
    [[], 'bench.cli.command_unknown'],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', '--unknown', 'x'],
      'bench.cli.argument_invalid',
    ],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', '--samples', '0'],
      'bench.cli.argument_invalid',
    ],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', '--samples', '1.5'],
      'bench.cli.argument_invalid',
    ],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', 'unexpected'],
      'bench.cli.argument_invalid',
    ],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', '--backend', 'sqlite'],
      'bench.cli.argument_invalid',
    ],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', '--warmup', '-1'],
      'bench.cli.argument_invalid',
    ],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', '--repetitions', '0'],
      'bench.cli.argument_invalid',
    ],
    [['compare', '--baseline', 'a'], 'bench.cli.argument_invalid'],
    [
      ['compare', '--baseline', 'base.json', '--candidate', 'candidate.json'],
      'bench.cli.argument_invalid',
    ],
    [
      ['run', '--case', 'case.json', '--out', 'run.json', '--impact', 'impact.json'],
      'bench.cli.argument_invalid',
    ],
    [['verify'], 'bench.cli.argument_invalid'],
    [
      ['derive', '--tea', 'schema.tea', '--out', 'generated', '--max-cases', '0'],
      'bench.cli.argument_invalid',
    ],
    [
      ['derive', '--tea', 'schema.tea', '--out', 'generated', '--max-cases', '1.5'],
      'bench.cli.argument_invalid',
    ],
    [['catalogue', 'enumerate', '--out', 'catalogue.json'], 'bench.cli.argument_invalid'],
    [['report', 'render', '--input', 'report.json'], 'bench.cli.argument_invalid'],
    [['report', 'render-html', '--input', 'report.json'], 'bench.cli.argument_invalid'],
    [['report', 'export-teable', '--out', 'rows.json'], 'bench.cli.argument_invalid'],
    [
      [
        'catalogue',
        'enumerate',
        '--out',
        'catalogue.json',
        '--markdown',
        'catalogue.md',
        '--max-search-states',
        '0',
      ],
      'bench.cli.argument_invalid',
    ],
  ] as const)('maps invalid argv %j to %s', async (argv, code) => {
    const context = setup();
    expect(await runBenchCli(argv, context.io, context.handlers)).toBe(1);
    expect(context.stdout).toEqual([]);
    expect(context.stderr).toHaveLength(1);
    expect(envelopeCode(context.stderr[0]!)).toBe(code);
  });

  it.each([
    ['run', ['run', '--case', 'case.json']],
    ['compare', ['compare', '--baseline', 'base.json', '--candidate', 'candidate.json']],
  ] as const)('requires an explicit --out for %s', async (command, argv) => {
    const context = setup();
    expect(await runBenchCli([...argv], context.io, context.handlers)).toBe(1);
    expect(envelopeCode(context.stderr[0]!)).toBe('bench.cli.argument_invalid');
    expect(context.handlers[command]).not.toHaveBeenCalled();
  });
  it('routes impact sidecar output and HTML input paths', async () => {
    vi.stubEnv('INIT_CWD', '/tmp/bench-invocation');
    const context = setup();
    await runBenchCli(
      [
        'run',
        '--case',
        'case.json',
        '--out',
        'run.json',
        '--evidence',
        'report.json',
        '--impact',
        'impact.json',
      ],
      context.io,
      context.handlers
    );
    expect(context.handlers.run).toHaveBeenCalledWith(
      expect.objectContaining({
        impactPath: '/tmp/bench-invocation/impact.json',
      })
    );
    await runBenchCli(
      [
        'report',
        'render-html',
        '--input',
        'report.json',
        '--impact',
        'impact.json',
        '--out',
        'report.html',
      ],
      context.io,
      context.handlers
    );
    expect(context.handlers.reportRenderHtml).toHaveBeenCalledWith(
      expect.objectContaining({
        impactPath: '/tmp/bench-invocation/impact.json',
      })
    );
  });

  it('accepts evidence output without a hand-authored provenance input', async () => {
    const context = setup();
    expect(
      await runBenchCli(
        ['run', '--case', 'case.json', '--out', 'run.json', '--evidence', 'evidence.json'],
        context.io,
        context.handlers
      )
    ).toBe(0);
    expect(context.handlers.run).toHaveBeenCalledWith(
      expect.objectContaining({
        evidencePath: resolve('evidence.json'),
        evidenceInputPath: undefined,
      })
    );
  });

  it('rejects evidence metadata without evidence output', async () => {
    const context = setup();
    expect(
      await runBenchCli(
        [
          'run',
          '--case',
          'case.json',
          '--out',
          'run.json',
          '--evidence-input',
          'evidence-input.json',
        ],
        context.io,
        context.handlers
      )
    ).toBe(1);
    expect(envelopeCode(context.stderr[0]!)).toBe('bench.cli.argument_invalid');
    expect(context.handlers.run).not.toHaveBeenCalled();
  });

  it('routes help through injected stdout without an error envelope', async () => {
    const context = setup();
    expect(await runBenchCli(['--help'], context.io, context.handlers)).toBe(0);
    expect(context.stdout.join('\n')).toContain('Teable v2 headless benchmark harness');
    expect(context.stderr).toEqual([]);
  });

  it('routes explicit run and compare output paths', async () => {
    vi.stubEnv('INIT_CWD', '/tmp/bench-invocation');
    const context = setup();
    await runBenchCli(
      ['run', '--case', 'case.json', '--out', 'run.json'],
      context.io,
      context.handlers
    );
    await runBenchCli(
      [
        'compare',
        '--baseline',
        'base.json',
        '--candidate',
        'candidate.json',
        '--out',
        'compare.json',
      ],
      context.io,
      context.handlers
    );
    expect(context.handlers.run).toHaveBeenCalledWith(
      expect.objectContaining({ outPath: '/tmp/bench-invocation/run.json' })
    );
    expect(context.handlers.compare).toHaveBeenCalledWith(
      expect.objectContaining({ outPath: '/tmp/bench-invocation/compare.json' })
    );
  });

  it('preserves explicit evidence and provenance-input paths', async () => {
    const context = setup();
    expect(
      await runBenchCli(
        [
          'run',
          '--case',
          'case.json',
          '--out',
          'run.json',
          '--evidence',
          'evidence.json',
          '--evidence-input',
          'evidence-input.json',
        ],
        context.io,
        context.handlers
      )
    ).toBe(0);
    expect(context.handlers.run).toHaveBeenCalledWith(
      expect.objectContaining({
        evidencePath: resolve('evidence.json'),
        evidenceInputPath: resolve('evidence-input.json'),
      })
    );
  });

  it('strips a leading pnpm script separator', async () => {
    const context = setup();
    expect(
      await runBenchCli(
        ['--', 'generate', '--spec', 'spec.json', '--out', 'generated'],
        context.io,
        context.handlers
      )
    ).toBe(0);
    expect(context.handlers.generate).toHaveBeenCalledOnce();
  });

  it('resolves user paths from INIT_CWD', async () => {
    vi.stubEnv('INIT_CWD', '/tmp/bench-invocation');
    const context = setup();
    await runBenchCli(
      ['derive', '--tea', 'schema.tea', '--out', 'cases', '--max-cases', '3', '--max-rows', '40'],
      context.io,
      context.handlers
    );
    expect(context.handlers.derive).toHaveBeenCalledWith({
      teaPath: '/tmp/bench-invocation/schema.tea',
      outDir: '/tmp/bench-invocation/cases',
      maxCases: 3,
      maxRows: 40,
    });
  });

  it('routes catalogue bounds and resolved output paths', async () => {
    vi.stubEnv('INIT_CWD', '/tmp/bench-invocation');
    const context = setup();
    await runBenchCli(
      [
        'catalogue',
        'enumerate',
        '--out',
        'catalogue.json',
        '--markdown',
        'catalogue.md',
        '--max-cases',
        '7',
        '--max-search-states',
        '19',
        '--max-millis',
        '250',
      ],
      context.io,
      context.handlers
    );
    expect(context.handlers.catalogueEnumerate).toHaveBeenCalledWith({
      outPath: '/tmp/bench-invocation/catalogue.json',
      markdownPath: '/tmp/bench-invocation/catalogue.md',
      maxCases: 7,
      maxSearchStates: 19,
      maxMillis: 250,
    });
    const envelope = JSON.parse(context.stdout[0]!) as {
      data: { counts: { scenarios: number }; familyCounts: Record<string, number> };
    };
    expect(envelope.data.counts.scenarios).toBeGreaterThan(0);
    expect(envelope.data.familyCounts).toEqual({});
  });

  it('materializes one exact stable catalogue scenario ID', async () => {
    vi.stubEnv('INIT_CWD', '/tmp/bench-invocation');
    const context = setup();
    await runBenchCli(
      ['catalogue', 'materialize', '--scenario', 'scn_exact', '--out', 'cases'],
      context.io,
      context.handlers
    );
    expect(context.handlers.catalogueMaterialize).toHaveBeenCalledWith({
      scenarioId: 'scn_exact',
      outDir: '/tmp/bench-invocation/cases',
    });
  });

  it('routes canonical v2 report render and Teable export paths', async () => {
    vi.stubEnv('INIT_CWD', '/tmp/bench-invocation');
    const context = setup();
    await runBenchCli(
      ['report', 'render', '--input', 'report.json', '--out', 'report.md'],
      context.io,
      context.handlers
    );
    await runBenchCli(
      ['report', 'render-html', '--input', 'report.json', '--out', 'report.html'],
      context.io,
      context.handlers
    );
    await runBenchCli(
      ['report', 'export-teable', '--input', 'report.json', '--out', 'rows.json'],
      context.io,
      context.handlers
    );
    expect(context.handlers.reportRender).toHaveBeenCalledWith({
      inputPath: '/tmp/bench-invocation/report.json',
      outPath: '/tmp/bench-invocation/report.md',
    });
    expect(context.handlers.reportRenderHtml).toHaveBeenCalledWith({
      inputPath: '/tmp/bench-invocation/report.json',
      outPath: '/tmp/bench-invocation/report.html',
    });
    expect(context.handlers.reportExportTeable).toHaveBeenCalledWith({
      inputPath: '/tmp/bench-invocation/report.json',
      outPath: '/tmp/bench-invocation/rows.json',
    });
  });

  it('emits one JSON envelope and preserves BenchError details', async () => {
    const context = setup({
      generate: vi.fn(async () => {
        throw new BenchError('bench.fixture.failed', 'Fixture failed', { fixture: 'spec.json' });
      }),
    });
    expect(
      await runBenchCli(
        ['generate', '--spec', 'spec.json', '--out', 'generated'],
        context.io,
        context.handlers
      )
    ).toBe(1);
    expect(context.stderr).toHaveLength(1);
    expect(JSON.parse(context.stderr[0]!)).toEqual({
      ok: false,
      error: {
        code: 'bench.fixture.failed',
        message: 'Fixture failed',
        details: { fixture: 'spec.json' },
      },
    });
  });

  it('maps unknown failures to bench.cli.unexpected', async () => {
    const context = setup({ verify: vi.fn(async () => Promise.reject(new Error('boom'))) });
    expect(await runBenchCli(['verify', '--run', 'run.json'], context.io, context.handlers)).toBe(
      1
    );
    expect(envelopeCode(context.stderr[0]!)).toBe('bench.cli.unexpected');
  });

  it('reports correctness separately and exits nonzero on a standalone performance SLO failure', async () => {
    const context = setup({
      run: vi.fn(async () => ({
        ...report('pass'),
        correctnessVerdict: 'pass' as const,
        performanceVerdict: 'fail' as const,
      })),
    });
    expect(
      await runBenchCli(
        ['run', '--case', 'case.json', '--out', 'run.json'],
        context.io,
        context.handlers
      )
    ).toBe(1);
    expect(JSON.parse(context.stdout[0]!)).toMatchObject({
      data: {
        correctnessVerdict: 'pass',
        performanceVerdict: 'fail',
        verdict: 'pass',
      },
    });
  });

  it.each([
    ['run', 'pass', 0],
    ['run', 'inconclusive', 0],
    ['run', 'fail', 1],
    ['verify', 'pass', 0],
    ['verify', 'inconclusive', 1],
    ['verify', 'fail', 1],
  ] as const)('maps %s %s to exit %i', async (command, verdict, exitCode) => {
    const context = setup({
      run: vi.fn(async () => report(verdict)),
      verify: vi.fn(async () => report(verdict)),
    });
    const argv =
      command === 'run'
        ? ['run', '--case', 'case.json', '--out', 'run.json']
        : ['verify', '--run', 'run.json'];
    expect(await runBenchCli(argv, context.io, context.handlers)).toBe(exitCode);
  });

  it.each([
    ['pass', 0],
    ['inconclusive', 0],
    ['fail', 1],
  ] as const)('maps compare %s to exit %i', async (verdict, exitCode) => {
    const context = setup({ compare: vi.fn(async () => comparison(verdict)) });
    expect(
      await runBenchCli(
        [
          'compare',
          '--baseline',
          'base.json',
          '--candidate',
          'candidate.json',
          '--out',
          'compare.json',
        ],
        context.io,
        context.handlers
      )
    ).toBe(exitCode);
  });
});
