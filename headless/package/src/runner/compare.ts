import { BenchError } from '../errors';
import type { BenchRunReport } from './BenchRunner';
import { minimumSamplesForPercentileResolution } from './metrics';

export type BenchCompareReport = {
  readonly baselineRunId: string;
  readonly candidateRunId: string;
  readonly caseId: string;
  readonly estimand?: 'descriptive-candidate-p95/baseline-p95';
  readonly inference?: 'unpaired-no-confidence-interval';
  readonly operations: ReadonlyArray<{
    readonly key: string;
    readonly baselineP95Ms: number | null;
    readonly candidateP95Ms: number | null;
    readonly effectRatio: number | null;
    readonly ciLow: number | null;
    readonly ciHigh: number | null;
    readonly verdict: 'pass' | 'fail' | 'inconclusive';
  }>;
  readonly verdict: 'pass' | 'fail' | 'inconclusive';
  readonly warnings: ReadonlyArray<string>;
};

export function compareReports(input: {
  baseline: BenchRunReport;
  candidate: BenchRunReport;
}): BenchCompareReport {
  if (input.baseline.caseId !== input.candidate.caseId) {
    throw new BenchError('bench.compare.case_mismatch', 'Reports belong to different cases');
  }

  const baselineByKey = new Map(
    input.baseline.operations.map((operation) => [operation.key, operation])
  );
  const candidateByKey = new Map(
    input.candidate.operations.map((operation) => [operation.key, operation])
  );
  const allKeys = [
    ...input.baseline.operations.map(({ key }) => key),
    ...input.candidate.operations.map(({ key }) => key).filter((key) => !baselineByKey.has(key)),
  ];
  const warnings: string[] = [];
  const operations: BenchCompareReport['operations'][number][] = [];
  const addWarning = (warning: string): void => {
    if (!warnings.includes(warning)) warnings.push(warning);
  };

  if (input.baseline.backend !== input.candidate.backend) {
    addWarning('bench.compare.backend_mismatch');
  }
  if (input.baseline.verdict !== 'pass') {
    addWarning(`bench.compare.baseline_${input.baseline.verdict}`);
  }
  if (input.candidate.verdict !== 'pass') {
    addWarning(`bench.compare.candidate_${input.candidate.verdict}`);
  }
  if (input.baseline.oracle.status !== 'pass') {
    addWarning(`bench.compare.baseline_oracle_${input.baseline.oracle.status}`);
  }
  if (input.candidate.oracle.status !== 'pass') {
    addWarning(`bench.compare.candidate_oracle_${input.candidate.oracle.status}`);
  }

  for (const key of allKeys) {
    const baseline = baselineByKey.get(key);
    const candidate = candidateByKey.get(key);
    if (!baseline || !candidate) {
      addWarning(`bench.compare.missing_operation:${key}`);
      continue;
    }
    if (baseline.kind !== candidate.kind) {
      addWarning(`bench.compare.operation_kind_mismatch:${key}`);
      continue;
    }
    const baselineP95Ms =
      baseline.p95Ms !== null && Number.isFinite(baseline.p95Ms) ? baseline.p95Ms : null;
    const candidateP95Ms =
      candidate.p95Ms !== null && Number.isFinite(candidate.p95Ms) ? candidate.p95Ms : null;
    const percentileEvidenceLow =
      baseline.samplesMs.length < minimumSamplesForPercentileResolution(0.95) ||
      candidate.samplesMs.length < minimumSamplesForPercentileResolution(0.95);
    if (percentileEvidenceLow) addWarning(`bench.compare.percentile_evidence_low:${key}`);
    addWarning(`bench.compare.pairing_evidence_missing:${key}`);
    operations.push({
      key,
      baselineP95Ms,
      candidateP95Ms,
      effectRatio:
        baselineP95Ms !== null && baselineP95Ms > 0 && candidateP95Ms !== null
          ? candidateP95Ms / baselineP95Ms
          : null,
      ciLow: null,
      ciHigh: null,
      verdict: 'inconclusive',
    });
  }

  const sloP95Ms = input.candidate.budgets?.sloP95Ms;
  let exceedsSlo = false;
  if (sloP95Ms != null) {
    for (const operation of input.candidate.operations) {
      if (operation.samplesMs.length < minimumSamplesForPercentileResolution(0.95)) continue;
      if (
        operation.p95Ms !== null &&
        Number.isFinite(operation.p95Ms) &&
        operation.p95Ms > sloP95Ms
      ) {
        exceedsSlo = true;
        addWarning(`bench.compare.slo_p95_exceeded:${operation.key}`);
      }
    }
  }
  const hasConcreteFailure =
    input.baseline.verdict === 'fail' ||
    input.candidate.verdict === 'fail' ||
    input.baseline.oracle.status === 'fail' ||
    input.candidate.oracle.status === 'fail' ||
    exceedsSlo;
  const verdict = hasConcreteFailure ? 'fail' : 'inconclusive';

  return {
    baselineRunId: input.baseline.runId,
    candidateRunId: input.candidate.runId,
    caseId: input.baseline.caseId,
    estimand: 'descriptive-candidate-p95/baseline-p95',
    inference: 'unpaired-no-confidence-interval',
    operations,
    verdict,
    warnings,
  };
}
