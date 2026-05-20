import type { INestApplication } from "@nestjs/common";
import type { IFieldRo } from "@teable/core";

export type PerfRunnerKind = "http-endpoint" | "formula-table";

export interface PerfCase {
  id: string;
  title: string;
  runner: PerfRunnerKind;
  timeoutMs: number;
  config: HttpEndpointCaseConfig | FormulaTableCaseConfig;
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
  formula: {
    name: string;
    expression: string;
  };
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric: "formulaReadyMs";
    maxMs: number;
  };
}

export const definePerfCase = <T extends PerfCase>(perfCase: T) => perfCase;
