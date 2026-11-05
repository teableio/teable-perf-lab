import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { materializeCatalogueScenario } from '../catalogue';
import { COMPLEXITY_BUDGET_MODEL_VERSION } from '../ci/complexityBudgetModel';
import { loadPinnedCalibrationArtifact } from './artifact';
import { parseComplexitySeriesCliArgs } from './cli';
import { evaluateComplexityCalibration, evaluateComplexityGate } from './evaluate';
import {
  COMPLEXITY_SERIES_DEFINITIONS,
  complexitySeriesBaseScenarios,
  createComplexitySeriesScenario,
} from './plan';
import { renderComplexityCalibrationMarkdown, renderComplexityGateMarkdown } from './report';
import { complexitySeriesMeasurementProtocol, gateComplexitySeries } from './runner';
import {
  COMPLEXITY_CALIBRATION_SCHEMA,
  type ComplexityCalibrationArtifact,
  type ComplexitySeriesDefinition,
  type ComplexitySeriesRole,
  type ComplexitySeriesSampleReceipt,
} from './types';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const provenance = {
  source: 'designated-baseline-run-42',
  runner: 'ubuntu-24.04-x64-8-core-postgres-16',
  calibratedAt: '2026-10-29T00:00:00.000Z',
} as const;

const measurementProtocol = complexitySeriesMeasurementProtocol(20);

function receipt(
  definition: ComplexitySeriesDefinition,
  role: ComplexitySeriesRole,
  workUnits: number,
  elapsedMs = workUnits,
  count = 20,
  overrides: Partial<ComplexitySeriesSampleReceipt> = {}
): ComplexitySeriesSampleReceipt {
  const samplesMs = Array.from({ length: count }, () => elapsedMs);
  return {
    role,
    ruleId: definition.ruleId,
    scenarioId: `scn_${'a'.repeat(64)}`,
    caseId: `sha256:${'b'.repeat(64)}`,
    runId: 'run-receipt',
    backend: 'postgres',
    runProvenance: {
      commit: 'abcdef1234567890',
      node: 'v24.0.0',
      platform: 'linux',
      arch: 'x64',
      runtime: 'postgres',
      postgresVersion: '16.4',
      startedAt: '2026-10-29T00:00:00.000Z',
      completedAt: '2026-10-29T00:01:00.000Z',
    },
    measurementProtocol,
    operationKey: definition.operationKey,
    operationFamily: definition.operationFamily,
    workUnits,
    schemaSize: {
      tableCount: definition.ruleId === 'R-PROP-003' ? 2 : 1,
      fieldCount: workUnits + 2,
      computedFieldCount: workUnits,
      rowsByTable: { Fixture: 100 },
      totalRows: 100,
      groundedDimension: { name: definition.dimension, workUnits },
    },
    complexityAssociation: {
      strategy: 'writes-since-previous-flush',
      linkedWriteKeys: [`write-${workUnits}`],
    },
    complexityAssessmentCount: 1,
    complexityAssessment: {
      assessmentKey: `write-${workUnits}`,
      policyVersion: 'v2-complexity-policy-2',
      score: workUnits,
      scoreSemantics: 'nullable-ranking-index',
      scoreProvenance: {
        kind: 'assumption-backed',
        assumption: 'changeRate',
        source: 'manifest.dimensions.complexityAssumptions.changeRateByOperation',
        declaredSource: 'complexity-series-conservative-upper-bound',
        evidence: 'Declared planning bound; not an observed change rate.',
      },
      declaredChangeRate: 1,
      components: { structural: workUnits, dataWork: 20, risk: 0 },
      association: {
        strategy: 'writes-since-previous-flush',
        linkedWriteKeys: [`write-${workUnits}`],
      },
      simulation: {
        assumptions: {
          changeRate: {
            source: 'unavailable',
            value: null,
            reason: 'no-explicit-manifest-assumption-or-deterministic-proof',
          },
        },
      },
      assumptions: { scoreMeaning: 'ranking-only', syntheticChangeRate: 'forbidden' },
    },
    correctnessVerdict: 'pass',
    operationFound: true,
    operationErrors: 0,
    sampleCount: samplesMs.length,
    samplesMs,
    actualP95Ms: elapsedMs,
    ...overrides,
  };
}

function calibratedSeries(definition: ComplexitySeriesDefinition) {
  return evaluateComplexityCalibration({
    definition,
    receipts: [
      ...definition.calibrationWorkUnits.map((workUnits) =>
        receipt(definition, 'calibration', workUnits)
      ),
      receipt(definition, 'holdout', definition.holdoutWorkUnits),
    ],
    headroom: 1.5,
    provenance,
    measurementProtocol,
  });
}

function artifact(): ComplexityCalibrationArtifact {
  const series = COMPLEXITY_SERIES_DEFINITIONS.map(calibratedSeries);
  return {
    schema: COMPLEXITY_CALIBRATION_SCHEMA,
    mode: 'calibrate',
    backend: 'postgres',
    modelVersion: COMPLEXITY_BUDGET_MODEL_VERSION,
    generatedAt: '2026-10-29T01:00:00.000Z',
    requestedSamplesPerPoint: 20,
    measurementProtocol,
    headroom: 1.5,
    provenance,
    verdict: 'pass',
    executionErrors: [],
    series,
  };
}

async function artifactWithCurrentCaseIdentities(
  outDir: string
): Promise<ComplexityCalibrationArtifact> {
  const current = artifact();
  const bases = complexitySeriesBaseScenarios();
  const series: ComplexityCalibrationArtifact['series'][number][] = [];
  for (const [index, definition] of COMPLEXITY_SERIES_DEFINITIONS.entries()) {
    const entry = current.series[index]!;
    const receipts: ComplexitySeriesSampleReceipt[] = [];
    for (const archived of entry.receipts) {
      const scenario = createComplexitySeriesScenario({
        source: bases.get(definition.ruleId)!,
        definition,
        role: archived.role,
        workUnits: archived.workUnits,
      });
      const materialized = await materializeCatalogueScenario({
        scenario,
        outDir: join(outDir, 'current-identities'),
      });
      const generated = materialized.cases[0];
      if (!generated) throw new Error(`No case for ${definition.ruleId}`);
      receipts.push({
        ...archived,
        scenarioId: scenario.scenarioId,
        caseId: generated.caseId,
      });
    }
    series.push({ ...entry, receipts });
  }
  return { ...current, series };
}

describe('complexity series calibration', () => {
  it('keeps each rule and operation key in a separate grounded series with an interior holdout', () => {
    expect(COMPLEXITY_SERIES_DEFINITIONS).toHaveLength(3);
    expect(new Set(COMPLEXITY_SERIES_DEFINITIONS.map((entry) => entry.operationFamily)).size).toBe(
      3
    );
    for (const definition of COMPLEXITY_SERIES_DEFINITIONS) {
      expect(definition.operationFamily).toContain(definition.ruleId);
      expect(definition.operationFamily).toContain(definition.operationKey);
      expect(definition.calibrationWorkUnits.length).toBeGreaterThanOrEqual(2);
      expect(definition.holdoutWorkUnits).toBeGreaterThan(
        Math.min(...definition.calibrationWorkUnits)
      );
      expect(definition.holdoutWorkUnits).toBeLessThan(
        Math.max(...definition.calibrationWorkUnits)
      );
    }
  });

  it('changes only the grounded dimension of each existing bounded template', () => {
    const bases = complexitySeriesBaseScenarios();
    for (const definition of COMPLEXITY_SERIES_DEFINITIONS) {
      const source = bases.get(definition.ruleId)!;
      const scenario = createComplexitySeriesScenario({
        source,
        definition,
        role: 'gate',
        workUnits: definition.gateWorkUnits,
      });
      expect(scenario.size[definition.dimension]).toBe(definition.gateWorkUnits);
      for (const dimension of ['graphDepth', 'graphWidth', 'fanout'] as const) {
        if (dimension !== definition.dimension) {
          expect(scenario.size[dimension]).toBe(source.size[dimension]);
        }
      }
      expect(scenario.size.rows).toBe(100);
      expect(scenario.fixture.reference).toBe(source.fixture.reference);
      expect(scenario.fixture.parameters).toMatchObject({
        complexityAssumptionChangeRate: 1,
        complexityAssumptionSource: 'complexity-series-conservative-upper-bound',
      });
      expect(String(scenario.fixture.parameters.complexityAssumptionEvidence)).toContain(
        'not an observed change rate'
      );
      expect(scenario.structuralIdentity).toContain('complexity-series-conservative-upper-bound');
    }
  });

  it('fits only measured samples and carries actual p95, provenance, and holdout receipts', () => {
    const result = calibratedSeries(COMPLEXITY_SERIES_DEFINITIONS[0]!);

    expect(result.calibration.status).toBe('calibrated');
    if (result.calibration.status !== 'calibrated') return;
    expect(result.calibration.model.modelVersion).toBe(COMPLEXITY_BUDGET_MODEL_VERSION);
    expect(result.calibration.model.provenance).toEqual(provenance);
    expect(result.calibration.model.validation.points).toEqual([
      {
        score: 6,
        physicalDimension: 'graphDepth',
        physicalValue: 6,
        sampleCount: 20,
        observedP95Ms: 6,
        predictedP95Ms: 6,
        maxP95Ms: 9,
        predictionErrorMs: 0,
        observedToPredictedRatio: 1,
      },
    ]);
    expect(result.receipts.every((entry) => entry.sampleCount === 20)).toBe(true);
  });

  it('reports the padded holdout budget beside actual and unpadded error evidence', () => {
    const definition = COMPLEXITY_SERIES_DEFINITIONS[0]!;
    const series = evaluateComplexityCalibration({
      definition,
      receipts: [
        ...definition.calibrationWorkUnits.map((workUnits) =>
          receipt(definition, 'calibration', workUnits)
        ),
        receipt(definition, 'holdout', definition.holdoutWorkUnits, 7),
      ],
      headroom: 1.5,
      provenance,
      measurementProtocol,
    });
    const report = artifact();
    const markdown = renderComplexityCalibrationMarkdown({
      ...report,
      series: [series, ...report.series.slice(1)],
    });

    expect(series.calibration.status).toBe('calibrated');
    expect(markdown).toContain('| holdout / operation |');
    expect(markdown).toContain('| 6 | 20 | 6 | 9 | 7 | pass / pass |');
    expect(markdown).toContain('Measured example:');
    expect(markdown).toContain('actual p95 7 ms');
    expect(markdown).toContain('20 samples are the minimum');
    expect(markdown).toContain('3x policy');
    expect(markdown.match(/^\| ---/gm)).toHaveLength(1);
    expect(markdown).not.toContain('```');
    expect(markdown).not.toContain('Receipt JSON');
  });

  it('keeps unavailable gate evidence explicit in one table without invented measurements', () => {
    const definition = COMPLEXITY_SERIES_DEFINITIONS[0]!;
    const markdown = renderComplexityGateMarkdown({
      schema: 'tea-bench-complexity-score-gate/3',
      mode: 'gate',
      backend: 'postgres',
      modelVersion: COMPLEXITY_BUDGET_MODEL_VERSION,
      generatedAt: '2026-10-29T01:00:00.000Z',
      runner: provenance.runner,
      requestedSamplesPerPoint: 20,
      measurementProtocol,
      calibrationEvidence: {
        status: 'unknown',
        path: 'missing.json',
        sha256: null,
        expectedSha256: 'a'.repeat(64),
        reason: 'calibration-artifact-missing',
      },
      verdict: 'inconclusive',
      executionErrors: [],
      series: [
        {
          ...definition,
          requestedWorkUnits: { gate: definition.gateWorkUnits },
          receipt: null,
          calibrationModel: null,
          gate: {
            verdict: 'unknown',
            reason: 'operation-not-found',
            actualP95Ms: null,
            maxP95Ms: null,
            prediction: null,
          },
        },
      ],
    });
    expect(markdown.match(/^\| ---/gm)).toHaveLength(1);
    expect(markdown).toContain('unknown:calibration-artifact-missing');
    expect(markdown).toContain('unknown:operation-not-found');
    expect(markdown).toContain('Example unavailable');
    expect(markdown).toContain(
      '| unknown | unknown | unknown | unknown | unknown | unknown / unknown:operation-not-found |'
    );
    expect(markdown).not.toContain('```');
  });

  it('rejects correctness failures, insufficient samples, and unrelated operation families', () => {
    const definition = COMPLEXITY_SERIES_DEFINITIONS[0]!;
    const valid = [
      receipt(definition, 'calibration', 2),
      receipt(definition, 'calibration', 8),
      receipt(definition, 'holdout', 6),
    ];
    const cases = [
      [
        { ...valid[0]!, correctnessVerdict: 'fail' as const },
        valid[1]!,
        valid[2]!,
        'correctness-failure',
      ],
      [receipt(definition, 'calibration', 2, 2, 19), valid[1]!, valid[2]!, 'insufficient-samples'],
      [
        { ...valid[0]!, operationFamily: 'R-FORMULA-005/transition-2-wait-computed' },
        valid[1]!,
        valid[2]!,
        'receipt-mismatch',
      ],
    ] as const;

    for (const [first, second, holdout, reason] of cases) {
      const result = evaluateComplexityCalibration({
        definition,
        receipts: [first, second, holdout],
        headroom: 1.5,
        provenance,
        measurementProtocol,
      });
      expect(result.calibration).toMatchObject({ status: 'unknown', reason, model: null });
    }
  });

  it('is inconclusive for missing and tied actual assessment scores', () => {
    const definition = COMPLEXITY_SERIES_DEFINITIONS[0]!;
    const low = receipt(definition, 'calibration', 2);
    const high = receipt(definition, 'calibration', 8);
    const holdout = receipt(definition, 'holdout', 6);
    const missing = evaluateComplexityCalibration({
      definition,
      receipts: [
        {
          ...low,
          complexityAssessment: { ...low.complexityAssessment!, score: null },
        },
        high,
        holdout,
      ],
      headroom: 1.5,
      provenance,
      measurementProtocol,
    });
    const tied = evaluateComplexityCalibration({
      definition,
      receipts: [
        low,
        {
          ...high,
          complexityAssessment: { ...high.complexityAssessment!, score: 2 },
        },
        holdout,
      ],
      headroom: 1.5,
      provenance,
      measurementProtocol,
    });

    expect(missing.calibration).toEqual({
      status: 'unknown',
      reason: 'missing-complexity-score',
      model: null,
    });
    expect(tied.calibration).toEqual({
      status: 'unknown',
      reason: 'tied-complexity-scores',
      model: null,
    });
    const multiple = evaluateComplexityCalibration({
      definition,
      receipts: [
        {
          ...low,
          complexityAssociation: {
            strategy: 'writes-since-previous-flush',
            linkedWriteKeys: ['write-a', 'write-b'],
          },
          complexityAssessmentCount: 2,
          complexityAssessment: null,
        },
        high,
        holdout,
      ],
      headroom: 1.5,
      provenance,
      measurementProtocol,
    });
    expect(multiple.calibration).toEqual({
      status: 'unknown',
      reason: 'multiple-complexity-assessments',
      model: null,
    });
  });
});

describe('complexity series gate', () => {
  it('uses a prior model without refitting and reports the current actual p95', () => {
    const definition = COMPLEXITY_SERIES_DEFINITIONS[0]!;
    const calibration = calibratedSeries(definition);
    if (calibration.calibration.status !== 'calibrated') throw new Error('fixture not calibrated');

    const result = evaluateComplexityGate({
      definition,
      model: calibration.calibration.model,
      receipt: receipt(definition, 'gate', definition.gateWorkUnits, 5),
      measurementProtocol,
    });

    expect(result.gate).toMatchObject({
      verdict: 'pass',
      actualP95Ms: 5,
      maxP95Ms: 6,
      prediction: { score: 4, lowerScore: 2, upperScore: 8 },
    });
    expect(result.calibrationModel).toBe(calibration.calibration.model);
  });

  it('rejects extrapolation instead of predicting an unrelated size', () => {
    const source = COMPLEXITY_SERIES_DEFINITIONS[0]!;
    const calibration = calibratedSeries(source);
    if (calibration.calibration.status !== 'calibrated') throw new Error('fixture not calibrated');
    const extrapolated = { ...source, gateWorkUnits: 9 };

    const result = evaluateComplexityGate({
      definition: extrapolated,
      model: calibration.calibration.model,
      receipt: receipt(extrapolated, 'gate', 9),
      measurementProtocol,
    });

    expect(result.gate).toMatchObject({
      verdict: 'unknown',
      reason: 'unsupported-extrapolation',
      maxP95Ms: null,
    });
  });

  it('does not execute a gate when pinned calibration evidence is missing', async () => {
    const report = await gateComplexitySeries({
      connectionString: 'postgresql://unused-because-evidence-is-missing',
      outDir: join(tmpdir(), 'unused-complexity-gate'),
      runner: provenance.runner,
      calibrationArtifactPath: join(tmpdir(), 'missing-calibration.json'),
      expectedCalibrationSha256: '0'.repeat(64),
    });

    expect(report.verdict).toBe('inconclusive');
    expect(report.calibrationEvidence).toMatchObject({
      status: 'unknown',
      reason: 'calibration-artifact-missing',
    });
    expect(report.series.every((entry) => entry.receipt === null)).toBe(true);
  });

  it('accepts dimension-valid current baseline identities before rejecting a different runner class', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'complexity-runner-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'calibration.json');
    const content = `${JSON.stringify(await artifactWithCurrentCaseIdentities(directory), null, 2)}\n`;
    await writeFile(path, content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');

    const report = await gateComplexitySeries({
      connectionString: 'postgresql://unused-because-runner-is-incompatible',
      outDir: join(directory, 'gate'),
      runner: 'different-runner-class',
      calibrationArtifactPath: path,
      expectedCalibrationSha256: sha256,
    });

    expect(report.verdict).toBe('inconclusive');
    expect(report.series.every((entry) => entry.gate.reason === 'incompatible-runner')).toBe(true);
    expect(report.executionErrors).toEqual([]);
    expect(report.series.every((entry) => entry.calibrationModel !== null)).toBe(true);
    expect(COMPLEXITY_SERIES_DEFINITIONS[0]!.calibrationWorkUnits).not.toContain(
      COMPLEXITY_SERIES_DEFINITIONS[0]!.gateWorkUnits
    );
    expect(report.series.every((entry) => entry.receipt === null)).toBe(true);
  });

  it.each(['calibration', 'holdout'] as const)(
    'rejects a pinned artifact when a recorded %s case no longer materializes identically',
    async (role) => {
      const directory = await mkdtemp(join(tmpdir(), 'complexity-stale-case-'));
      temporaryDirectories.push(directory);
      const path = join(directory, 'calibration.json');
      const current = await artifactWithCurrentCaseIdentities(directory);
      const first = current.series[0]!;
      const stale: ComplexityCalibrationArtifact = {
        ...current,
        series: [
          {
            ...first,
            receipts: first.receipts.map((entry) =>
              entry.role === role ? { ...entry, caseId: `sha256:${'f'.repeat(64)}` } : entry
            ),
          },
          ...current.series.slice(1),
        ],
      };
      const content = `${JSON.stringify(stale, null, 2)}\n`;
      await writeFile(path, content, 'utf8');
      const sha256 = createHash('sha256').update(content).digest('hex');

      const report = await gateComplexitySeries({
        connectionString: 'postgresql://unused-because-case-identity-is-stale',
        outDir: join(directory, 'gate'),
        runner: 'different-runner-class',
        calibrationArtifactPath: path,
        expectedCalibrationSha256: sha256,
      });

      expect(report.verdict).toBe('inconclusive');
      expect(report.series[0]?.gate.reason).toBe('calibration-artifact-invalid');
      expect(report.executionErrors[0]?.message).toMatch(
        /^caseId mismatch: .*recalibration required$/
      );
      expect(
        report.series.slice(1).every((entry) => entry.gate.reason === 'incompatible-runner')
      ).toBe(true);
    }
  );
});

describe('measurement protocol compatibility', () => {
  it.each([
    ['missing protocol', undefined, 'measurementProtocol'],
    ['old warmup behavior', { ...measurementProtocol, version: 1 }, 'measurementProtocol.version'],
    ['warmup count', { ...measurementProtocol, warmup: 0 }, 'measurementProtocol.warmup'],
    [
      'sample count',
      { ...measurementProtocol, samplesPerPoint: 21 },
      'measurementProtocol.samplesPerPoint',
    ],
    ['repetitions', { ...measurementProtocol, repetitions: 2 }, 'measurementProtocol.repetitions'],
  ])('rejects %s with a named compatibility field', async (_name, recordedProtocol, field) => {
    const directory = await mkdtemp(join(tmpdir(), 'complexity-stale-protocol-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'calibration.json');
    const content = `${JSON.stringify({ ...artifact(), measurementProtocol: recordedProtocol }, null, 2)}\n`;
    await writeFile(path, content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');

    const report = await gateComplexitySeries({
      connectionString: 'postgresql://unused-because-protocol-is-stale',
      outDir: join(directory, 'gate'),
      runner: provenance.runner,
      calibrationArtifactPath: path,
      expectedCalibrationSha256: sha256,
    });

    expect(report.verdict).toBe('inconclusive');
    expect(report.calibrationEvidence).toMatchObject({
      status: 'unknown',
      reason: 'calibration-artifact-invalid',
      message: expect.stringContaining(String(field)),
    });
    expect(report.series.every((entry) => entry.receipt === null)).toBe(true);
  });
});

describe('calibration artifact and integration contract', () => {
  it('loads only an externally pinned artifact with validated interior holdouts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'complexity-series-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'calibration.json');
    const content = `${JSON.stringify(artifact(), null, 2)}\n`;
    await writeFile(path, content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');

    await expect(
      loadPinnedCalibrationArtifact({ path, expectedSha256: sha256 })
    ).resolves.toMatchObject({ status: 'loaded', sha256 });
    await expect(
      loadPinnedCalibrationArtifact({ path, expectedSha256: 'f'.repeat(64) })
    ).resolves.toMatchObject({
      status: 'unknown',
      reason: 'calibration-artifact-hash-mismatch',
    });
  });

  it('rejects legacy raw-dimension budget artifacts even when their digest is pinned', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'legacy-complexity-series-'));
    temporaryDirectories.push(directory);
    const path = join(directory, 'calibration.json');
    const legacy = {
      ...artifact(),
      schema: 'tea-bench-complexity-calibration/1',
      modelVersion: 'tea-bench-complexity-budget/1',
    };
    const content = `${JSON.stringify(legacy, null, 2)}\n`;
    await writeFile(path, content, 'utf8');
    const sha256 = createHash('sha256').update(content).digest('hex');

    await expect(
      loadPinnedCalibrationArtifact({ path, expectedSha256: sha256 })
    ).resolves.toMatchObject({ status: 'unknown', reason: 'calibration-artifact-invalid' });
  });

  it('requires explicit calibrate/gate modes and immutable gate evidence', () => {
    expect(() => parseComplexitySeriesCliArgs([], {})).toThrow(/explicit/);
    expect(() =>
      parseComplexitySeriesCliArgs(
        [
          'gate',
          '--connection-string',
          'postgresql://db',
          '--runner',
          'runner-class',
          '--calibration',
          'baseline.json',
        ],
        {}
      )
    ).toThrow(/calibration-sha256/);
    const config = parseComplexitySeriesCliArgs(
      [
        'calibrate',
        '--connection-string',
        'postgresql://db',
        '--out-dir',
        'receipts',
        '--headroom',
        '1.5',
        '--source',
        'baseline-job',
        '--runner',
        'runner-class',
      ],
      {}
    );
    expect(config.mode).toBe('calibrate');
  });

  it('renders truthful unknown calibration rather than a fabricated budget', () => {
    const report = artifact();
    const first = report.series[0]!;
    const unknown: ComplexityCalibrationArtifact = {
      ...report,
      verdict: 'inconclusive',
      series: [
        {
          ...first,
          calibration: { status: 'unknown', reason: 'insufficient-samples', model: null },
        },
        ...report.series.slice(1),
      ],
    };

    const markdown = renderComplexityCalibrationMarkdown(unknown);
    expect(markdown).toContain('unknown:insufficient-samples');
  });
});
