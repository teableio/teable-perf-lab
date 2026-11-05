import type { CreateTeaBenchReportFromRunInput } from '../report/fromBenchRun';
import { createTeaBenchReportFromRun } from '../report/fromBenchRun';
import type { TeaBenchReport } from '../report/schema';
import type { BenchRunReport } from '../runner/BenchRunner';

/**
 * Serializes a fresh runner result as the canonical tea-bench-report/2 format.
 *
 * Provenance and configured catalogue scope are deliberately supplied by the
 * caller: a BenchRunReport does not contain enough information to reconstruct
 * either without inventing evidence.
 */
export function serializeBenchEvidence(
  run: BenchRunReport,
  input: CreateTeaBenchReportFromRunInput
): TeaBenchReport {
  if (input.mode !== 'fresh') {
    throw new Error('Runner evidence serialization requires an explicit fresh adapter input.');
  }
  return createTeaBenchReportFromRun(run, input);
}
