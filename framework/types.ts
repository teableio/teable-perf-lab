import type { INestApplication } from "@nestjs/common";
import type { IFieldRo } from "@teable/core";

export type PerfRunnerKind =
  | "http-endpoint"
  | "formula-table"
  | "conditional-lookup";

export interface PerfCase {
  id: string;
  title: string;
  runner: PerfRunnerKind;
  timeoutMs: number;
  config:
    | HttpEndpointCaseConfig
    | FormulaTableCaseConfig
    | ConditionalLookupCaseConfig;
}

export interface PerfRunContext {
  app: INestApplication;
  appUrl: string;
  runId: string;
  artifactDir?: string;
}

export interface MetricThreshold {
  metric: string;
  max: number;
  unit: string;
}

export interface PerfPhase {
  name: string;
  durationMs: number;
}

export interface PerfRunResult {
  metrics: Record<string, number>;
  thresholds: MetricThreshold[];
  phases?: PerfPhase[];
  details?: Record<string, unknown>;
}

export class PerfRunDiagnosticError extends Error {
  constructor(
    message: string,
    public readonly result: PerfRunResult,
  ) {
    super(message);
    this.name = "PerfRunDiagnosticError";
  }
}

export interface HttpEndpointCaseConfig {
  method: "GET";
  path: string;
  samples: number;
  threshold: {
    metric: "p95Ms";
    maxMs: number;
  };
  validateSeedUser?: boolean;
}

export type FormulaExpectedKind =
  | "aTimesBPlusC"
  | "aPlusBPlusC"
  | "aTimesCPlusB"
  | "aPlusBTimesC"
  | "weightedABC";

export interface FormulaFieldCaseConfig {
  name: string;
  expression: string;
  expected?: FormulaExpectedKind;
}

export interface FormulaTableCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  recordCount: number;
  batchSize: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "numeric-sequence";
    titlePrefix: string;
  };
  formula?: FormulaFieldCaseConfig;
  formulas?: FormulaFieldCaseConfig[];
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric: "formulaReadyMs" | "formulasReadyMs";
    maxMs: number;
  };
}

export interface ConditionalLookupCaseConfig {
  baseId: "seed-base";
  sourceTableNamePrefix: string;
  hostTableNamePrefix: string;
  recordCount: number;
  batchSize: number;
  generator: {
    type: "permuted-unique-key-sequence";
    sourceKeyPrefix: string;
    hostKeyPrefix: string;
    sourceValuePrefix: string;
    permutation: {
      multiplier: number;
      offset: number;
    };
  };
  lookup: {
    name: string;
    limit: number;
  };
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric: "conditionalLookupReadyMs";
    maxMs: number;
  };
}

export const definePerfCase = <T extends PerfCase>(perfCase: T) => perfCase;
