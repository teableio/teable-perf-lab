import type { BenchOracle } from '../case/manifest';
import { getLoadedCaseExecutionContext } from '../case/TeaCaseLoader';
import type { LoadedCase } from '../case/types';

import { evaluateExpectedJson } from './expectedJson';
import { evaluateFullRecompute, type FullRecomputeReferenceStore } from './fullRecompute';
import { evaluateInvariants } from './invariant';

export type BenchOracleCheckReceipt = {
  readonly key: string;
  readonly checkId: string;
  readonly kind: BenchOracle['kind'];
  readonly status: 'pass' | 'fail' | 'unknown';
  readonly description: string;
  readonly table: string | null;
  readonly field: string | null;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly tolerance: unknown;
  readonly obligationIds: ReadonlyArray<string>;
  readonly rowsMatched: number | null;
  readonly method: string;
  readonly message?: string;
  readonly details?: unknown;
};

export type BenchOracleResult = {
  readonly status: 'pass' | 'fail' | 'not-run';
  readonly checks: ReadonlyArray<BenchOracleCheckReceipt>;
  readonly warnings: ReadonlyArray<string>;
};

export async function runOracles(input: {
  loaded: LoadedCase;
  teaPath: string;
  fullRecomputeReferences?: FullRecomputeReferenceStore;
  scopeCheckId?: (checkId: string) => string;
}): Promise<BenchOracleResult> {
  if (input.loaded.manifest.oracle.length === 0) {
    return {
      status: 'not-run',
      checks: [],
      warnings: ['bench.oracle.not_configured'],
    };
  }

  const execution = getLoadedCaseExecutionContext(input.loaded);
  const checks: Array<BenchOracleResult['checks'][number]> = [];
  const scopeCheckId = input.scopeCheckId ?? ((checkId: string) => checkId);

  for (const [oracleIndex, oracle] of input.loaded.manifest.oracle.entries()) {
    if (oracle.kind === 'expected-json') {
      const result = await evaluateExpectedJson({
        loaded: input.loaded,
        manifestDir: execution.manifestDir,
        path: oracle.path,
        checkId: scopeCheckId(oracle.checkId ?? `${oracle.key}/expected-json`),
        description: oracle.description,
        obligationIds: oracle.obligationIds,
      });
      checks.push({ key: oracle.key, kind: oracle.kind, ...result });
      continue;
    }

    if (oracle.kind === 'invariant') {
      const outcomes = await evaluateInvariants({
        loaded: input.loaded,
        groupKey: oracle.key,
        checks: oracle.checks,
      });
      checks.push(
        ...outcomes.map((outcome) => ({
          key: oracle.key,
          kind: oracle.kind,
          ...outcome,
          checkId: scopeCheckId(outcome.checkId),
        }))
      );
      continue;
    }

    const result = await evaluateFullRecompute({
      loaded: input.loaded,
      teaPath: input.teaPath,
      tables: oracle.tables,
      maxRows: oracle.maxRows,
      checkId: scopeCheckId(oracle.checkId ?? `${oracle.key}/full-recompute`),
      description: oracle.description,
      obligationIds: oracle.obligationIds,
      reuse: oracle.reuse,
      reference: input.fullRecomputeReferences
        ? {
            key: `oracle:${oracleIndex}:${oracle.key}`,
            store: input.fullRecomputeReferences,
          }
        : undefined,
    });
    checks.push({ key: oracle.key, kind: oracle.kind, ...result });
  }

  return {
    status: checks.some((check) => check.status === 'fail')
      ? 'fail'
      : checks.some((check) => check.status === 'unknown')
        ? 'not-run'
        : 'pass',
    checks,
    warnings: [],
  };
}
