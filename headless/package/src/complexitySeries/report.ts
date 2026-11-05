import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
  ComplexityCalibrationArtifact,
  ComplexityCalibrationSeriesResult,
  ComplexityGateReport,
  ComplexitySeriesSampleReceipt,
} from './types';

type ComplexitySeriesReport = ComplexityCalibrationArtifact | ComplexityGateReport;

const cell = (value: unknown): string => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const number = (value: number | null): string =>
  value === null ? 'unknown' : Number.isInteger(value) ? String(value) : value.toFixed(3);

const tableHeader = [
  '| Rule | Role / scope | Operation key | Dimension / value | Complexity score | Samples | Expected p95 ms | Budget p95 ms | Actual p95 ms | Correctness / verdict |',
  '| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |',
];

function explanation(samples: number, headroom: string): string[] {
  return [
    `Each point requests ${samples} independent measured samples of the named operation (20 samples are the minimum for empirical p95); sample counts below report actual evidence, not a whole-workload timing.`,
    'Complexity score is a ranking index from the operation assessment, not milliseconds or a performance score. Expected p95 is the fitted empirical latency at that score; budget p95 applies the preselected headroom. Fixed whole-workload budgets are a separate gate and are not represented here.',
    `The 3x policy means budget = expected p95 × 3 when headroom is 3; this report uses ${headroom}. Headroom is selected before the independent holdout, not tuned to the current gate run. Calibration points fit the model; holdout points validate it without fitting; gate points use the pinned independent model.`,
    'Unknown values and reasons indicate missing or unusable evidence, never zero latency. Full receipts and raw samples remain in the machine-readable evidence artifact.',
    '',
  ];
}

function example(
  receipt: ComplexitySeriesSampleReceipt | undefined,
  expected: number | null,
  budget: number | null
): string {
  if (!receipt || receipt.actualP95Ms === null || expected === null || budget === null) {
    return 'Example unavailable: no measured point with an expected p95 and budget is available.';
  }
  return `Measured example: ${cell(receipt.ruleId)} ${receipt.role}, ${receipt.schemaSize.groundedDimension.name}=${receipt.workUnits}, complexity score ${number(receipt.complexityAssessment?.score ?? null)}, ${receipt.sampleCount} samples: expected p95 ${number(expected)} ms, budget ${number(budget)} ms, actual p95 ${number(receipt.actualP95Ms)} ms; correctness ${receipt.correctnessVerdict}.`;
}

function calibrationLatency(
  entry: ComplexityCalibrationSeriesResult,
  role: string,
  workUnits: number
): { expected: number | null; budget: number | null } {
  const model = entry.calibration.model;
  if (!model) return { expected: null, budget: null };
  if (role === 'holdout') {
    const point = model.validation.points.find((item) => item.physicalValue === workUnits);
    return { expected: point?.predictedP95Ms ?? null, budget: point?.maxP95Ms ?? null };
  }
  const point = model.points.find((item) => item.physicalValue === workUnits);
  if (!point) return { expected: null, budget: null };
  return { expected: point.boundedP95Ms, budget: point.boundedP95Ms * model.headroom };
}

function calibrationPointVerdict(
  entry: ComplexityCalibrationSeriesResult,
  receipt: ComplexitySeriesSampleReceipt | undefined,
  role: string,
  budget: number | null
): string {
  if (entry.calibration.status === 'unknown') return `unknown:${entry.calibration.reason}`;
  if (!receipt) return 'unknown:missing-receipt';
  if (role === 'calibration') return 'fit point (not validation)';
  if (receipt.actualP95Ms === null || budget === null) return 'unknown:missing-latency';
  return receipt.actualP95Ms <= budget ? 'pass' : 'fail';
}

function calibrationRow(
  entry: ComplexityCalibrationSeriesResult,
  role: string,
  workUnits: number
): string {
  const receipt = entry.receipts.find((item) => item.role === role && item.workUnits === workUnits);
  const { expected, budget } = calibrationLatency(entry, role, workUnits);
  const verdict = calibrationPointVerdict(entry, receipt, role, budget);
  return `| ${entry.ruleId} | ${role} / operation | ${cell(entry.operationKey)} | ${entry.dimension}=${workUnits} | ${number(receipt?.complexityAssessment?.score ?? null)} | ${receipt?.sampleCount ?? 'unknown'} | ${number(expected)} | ${number(budget)} | ${number(receipt?.actualP95Ms ?? null)} | ${receipt?.correctnessVerdict ?? 'unknown'} / ${verdict} |`;
}

export function renderComplexityCalibrationMarkdown(report: ComplexityCalibrationArtifact): string {
  const exampleSeries = report.series.find((entry) =>
    entry.calibration.model?.validation.points.some((point) =>
      entry.receipts.some(
        (receipt) => receipt.role === 'holdout' && receipt.workUnits === point.physicalValue
      )
    )
  );
  const examplePoint = exampleSeries?.calibration.model?.validation.points.find((point) =>
    exampleSeries.receipts.some(
      (receipt) => receipt.role === 'holdout' && receipt.workUnits === point.physicalValue
    )
  );
  const exampleReceipt = exampleSeries?.receipts.find(
    (receipt) => receipt.role === 'holdout' && receipt.workUnits === examplePoint?.physicalValue
  );
  const lines = [
    '<!-- schema: tea-bench-complexity-score-calibration/3 -->',
    '# Complexity Calibration',
    '',
    `- Verdict: **${report.verdict}**`,
    `- Backend: \`${report.backend}\``,
    `- Model version: \`${report.modelVersion}\``,
    `- Generated: \`${report.generatedAt}\``,
    `- Samples per point: ${report.requestedSamplesPerPoint}`,
    `- Headroom: ${report.headroom}`,
    `- Runner: \`${report.provenance.runner}\``,
    `- Source: \`${report.provenance.source}\``,
    `- Calibrated at: \`${report.provenance.calibratedAt}\``,
    '',
    ...explanation(report.requestedSamplesPerPoint, String(report.headroom)),
    '## Operation score-model results',
    '',
    ...tableHeader,
    ...report.series.flatMap((entry) => [
      ...entry.requestedWorkUnits.calibration.map((workUnits) =>
        calibrationRow(entry, 'calibration', workUnits)
      ),
      calibrationRow(entry, 'holdout', entry.requestedWorkUnits.holdout),
    ]),
    '',
    example(exampleReceipt, examplePoint?.predictedP95Ms ?? null, examplePoint?.maxP95Ms ?? null),
    '',
    '## Execution errors',
    '',
    ...(report.executionErrors.length === 0
      ? ['- none']
      : report.executionErrors.map(
          (error) => `- ${error.ruleId} ${error.role} ${error.workUnits}: ${cell(error.message)}`
        )),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function renderComplexityGateMarkdown(report: ComplexityGateReport): string {
  const measuredExample = report.series.find(
    (entry) =>
      entry.receipt != null && entry.receipt.actualP95Ms !== null && entry.gate.prediction !== null
  );
  const evidence =
    report.calibrationEvidence.status === 'loaded'
      ? [
          `- Calibration artifact: \`${report.calibrationEvidence.path}\``,
          `- Calibration SHA-256: \`${report.calibrationEvidence.sha256}\``,
          `- Calibration runner: \`${report.calibrationEvidence.provenance.runner}\``,
          `- Calibration source: \`${report.calibrationEvidence.provenance.source}\``,
          `- Calibration generated: \`${report.calibrationEvidence.generatedAt}\``,
        ]
      : [
          `- Calibration artifact: \`${report.calibrationEvidence.path}\``,
          `- Calibration evidence: **unknown:${report.calibrationEvidence.reason}**`,
          `- Expected SHA-256: \`${report.calibrationEvidence.expectedSha256}\``,
          `- Actual SHA-256: \`${report.calibrationEvidence.sha256 ?? 'unknown'}\``,
        ];
  const lines = [
    '<!-- schema: tea-bench-complexity-score-gate/3 -->',
    '# Complexity Gate',
    '',
    `- Verdict: **${report.verdict}**`,
    `- Backend: \`${report.backend}\``,
    `- Model version: \`${report.modelVersion}\``,
    `- Generated: \`${report.generatedAt}\``,
    `- Current runner: \`${report.runner}\``,
    `- Samples per point: ${report.requestedSamplesPerPoint}`,
    ...evidence,
    '',
    ...explanation(
      report.requestedSamplesPerPoint,
      report.series
        .flatMap((entry) =>
          entry.calibrationModel ? [String(entry.calibrationModel.headroom)] : []
        )
        .join(', ') || 'unknown headroom'
    ),
    '## Operation score-model results',
    '',
    ...tableHeader,
    ...report.series.flatMap((entry) => [
      `| ${entry.ruleId} | gate / operation | ${cell(entry.operationKey)} | ${entry.dimension}=${entry.requestedWorkUnits.gate} | ${number(entry.receipt?.complexityAssessment?.score ?? null)} | ${entry.receipt?.sampleCount ?? 'unknown'} | ${number(entry.gate.prediction?.empiricalP95Ms ?? null)} | ${number(entry.gate.maxP95Ms)} | ${number(entry.gate.actualP95Ms)} | ${entry.receipt?.correctnessVerdict ?? 'unknown'} / ${entry.gate.verdict === 'unknown' ? `unknown:${entry.gate.reason}` : entry.gate.verdict} |`,
      ...(entry.calibrationModel?.validation.points.map(
        (point) =>
          `| ${entry.ruleId} | pinned holdout / operation | ${cell(entry.operationKey)} | ${point.physicalDimension}=${point.physicalValue} | ${number(point.score)} | ${point.sampleCount} | ${number(point.predictedP95Ms)} | ${number(point.maxP95Ms)} | ${number(point.observedP95Ms)} | validated calibration / ${point.observedP95Ms <= point.maxP95Ms ? 'pass' : 'fail'} |`
      ) ?? []),
    ]),
    '',
    example(
      measuredExample?.receipt ?? undefined,
      measuredExample?.gate.prediction?.empiricalP95Ms ?? null,
      measuredExample?.gate.maxP95Ms ?? null
    ),
    '',
    '## Execution errors',
    '',
    ...(report.executionErrors.length === 0
      ? ['- none']
      : report.executionErrors.map(
          (error) => `- ${error.ruleId} gate ${error.workUnits}: ${cell(error.message)}`
        )),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function renderComplexitySeriesMarkdown(report: ComplexitySeriesReport): string {
  return report.mode === 'calibrate'
    ? renderComplexityCalibrationMarkdown(report)
    : renderComplexityGateMarkdown(report);
}

export async function writeComplexitySeriesReports(input: {
  readonly report: ComplexitySeriesReport;
  readonly jsonPath: string;
  readonly markdownPath: string;
}): Promise<void> {
  await Promise.all([
    mkdir(dirname(input.jsonPath), { recursive: true }),
    mkdir(dirname(input.markdownPath), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(input.jsonPath, `${JSON.stringify(input.report, null, 2)}\n`, 'utf8'),
    writeFile(input.markdownPath, renderComplexitySeriesMarkdown(input.report), 'utf8'),
  ]);
}
