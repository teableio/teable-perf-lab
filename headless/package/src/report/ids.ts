import { canonicalJson, sha256Hex } from '../case/canonicalJson';

export type ReportIdKind = 'catalogue' | 'scenario' | 'execution';

export function createStableReportId(kind: ReportIdKind, identity: unknown): string {
  return `${kind}_${sha256Hex(canonicalJson({ kind, identity }))}`;
}

export function createReportIds(identity: {
  readonly catalogue: unknown;
  readonly scenario: unknown;
  readonly execution: unknown;
}): { readonly catalogueId: string; readonly scenarioId: string; readonly executionId: string } {
  return {
    catalogueId: createStableReportId('catalogue', identity.catalogue),
    scenarioId: createStableReportId('scenario', identity.scenario),
    executionId: createStableReportId('execution', identity.execution),
  };
}
