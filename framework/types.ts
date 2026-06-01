import type { INestApplication } from "@nestjs/common";
import type { IFieldRo } from "@teable/core";

export type PerfRunnerKind =
  | "http-endpoint"
  | "formula-table"
  | "conditional-lookup"
  | "record-paste"
  | "record-delete"
  | "record-undo"
  | "record-redo"
  | "selection-clear";

export interface PerfCase {
  id: string;
  title: string;
  runner: PerfRunnerKind;
  timeoutMs: number;
  config:
    | HttpEndpointCaseConfig
    | FormulaTableCaseConfig
    | ConditionalLookupCaseConfig
    | RecordPasteCaseConfig
    | RecordDeleteCaseConfig
    | RecordUndoCaseConfig
    | RecordRedoCaseConfig
    | SelectionClearCaseConfig;
}

export interface PerfRunContext {
  app: INestApplication;
  appUrl: string;
  cookie?: string;
  runId: string;
  engine: string;
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
  result?: "pass" | "skipped";
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
    fullScanPageSize?: number;
  };
  threshold: {
    metric:
      | "formulaReadyMs"
      | "formulasReadyMs"
      | "formulaFullReadyMs"
      | "formulasFullReadyMs";
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
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "conditionalLookupReadyMs";
    maxMs: number;
  };
}

export interface RecordPasteCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  maxPasteCells?: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "flat-copy-paste" | "mixed-copy-paste";
    titlePrefix: string;
    groups?: string[];
    payloadPrefix?: string;
    valuePrefix?: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "paste10kMs";
    maxMs: number;
  };
}

export interface SelectionClearCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "flat-table-operation";
    titlePrefix: string;
    payloadPrefix: string;
    groups?: string[];
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "clear10kMs";
    maxMs: number;
  };
}

export interface RecordUndoRedoBaseCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "mixed-undo-redo";
    titlePrefix: string;
    payloadPrefix: string;
    source?: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
}

export interface RecordDeleteCaseConfig extends RecordUndoRedoBaseCaseConfig {
  threshold: {
    metric: "delete10kMs";
    maxMs: number;
  };
}

export interface RecordUndoCaseConfig extends RecordUndoRedoBaseCaseConfig {
  threshold: {
    metric: "undoReplay10kMs";
    maxMs: number;
  };
}

export interface RecordRedoCaseConfig extends RecordUndoRedoBaseCaseConfig {
  threshold: {
    metric: "redoReplay10kMs" | "redoReplay1kMs";
    maxMs: number;
  };
}

export const definePerfCase = <T extends PerfCase>(perfCase: T) => perfCase;
