import type { INestApplication } from "@nestjs/common";
import type { IFieldRo } from "@teable/core";

export type PerfRunnerKind =
  | "http-endpoint"
  | "formula-table"
  | "conditional-lookup"
  | "lookup-search-index"
  | "field-create"
  | "field-duplicate"
  | "csv-import"
  | "record-paste"
  | "record-create"
  | "record-update"
  | "record-reorder"
  | "record-delete"
  | "record-undo"
  | "record-redo"
  | "selection-clear";

export interface PerfCase {
  id: string;
  title: string;
  runner: PerfRunnerKind;
  timeoutMs: number;
  runtimeEnv?: Record<string, string | number | boolean>;
  config:
    | HttpEndpointCaseConfig
    | FormulaTableCaseConfig
    | ConditionalLookupCaseConfig
    | LookupSearchIndexCaseConfig
    | FieldCreateCaseConfig
    | FieldDuplicateCaseConfig
    | CsvImportCaseConfig
    | RecordPasteCaseConfig
    | RecordCreateCaseConfig
    | RecordUpdateCaseConfig
    | RecordReorderCaseConfig
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

export interface LookupSearchKeywordConfig {
  name: string;
  value: string;
  expectedHitCount?: number;
  expectedMinHitCount?: number;
  expectedFieldGroup:
    | "lookup-key"
    | "own-text"
    | "lookup-text"
    | "own-select"
    | "lookup-select"
    | "own-multiple-select"
    | "lookup-multiple-select"
    | "user";
}

export interface LookupSearchIndexCaseConfig {
  baseId: "seed-base";
  sourceTableNamePrefix: string;
  hostTableNamePrefix: string;
  tableIndexMode: "off" | "on";
  recordCount: number;
  batchSize: number;
  userCount: number;
  samples: number;
  generator: {
    type: "lookup-search-index-20-fields";
    sourceKeyPrefix: string;
    hostKeyPrefix: string;
    sourceTextPrefix: string;
    permutation: {
      multiplier: number;
      offset: number;
    };
  };
  keywords: LookupSearchKeywordConfig[];
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric: "lookupSearchIndexP95Ms";
    maxMs: number;
  };
}

export interface FieldCreateCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  baseFields: Array<IFieldRo & { id?: string; name: string }>;
  field: IFieldRo & { id?: string; name: string };
  verify: {
    optionCount: number;
    sampleOptionIndexes: number[];
  };
  threshold: {
    metric: "singleSelectCreateOptionsMs";
    maxMs: number;
  };
}

export interface FieldDuplicateCaseConfig
  extends Omit<ConditionalLookupCaseConfig, "threshold"> {
  duplicate: {
    name: string;
  };
  threshold: {
    metric: "conditionalLookupDuplicateReadyMs";
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

export interface CsvImportCaseConfig {
  baseId: "seed-base";
  targetMode?: "inplace" | "create-table";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "mixed-csv-import";
    titlePrefix: string;
    payloadPrefix: string;
    valuePrefix: string;
    compact?: boolean;
  };
  verify: {
    sampleRows: number[];
  };
  threshold: {
    metric:
      | "csvInplaceImportReadyMs"
      | "csvCreateTableImportReadyMs"
      | "csvCreateTableImportCompletedMs";
    maxMs: number;
  };
}

export interface RecordCreateCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "mixed-record-create";
    titlePrefix: string;
    payloadPrefix: string;
    valuePrefix: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "bulkCreate1kMs";
    maxMs: number;
  };
}

export interface RecordUpdateCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "mixed-record-update";
    seedPrefix: string;
    updatePrefix: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "bulkUpdate1kMs";
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
    metric: "clear1kMs";
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
    metric: "delete1kMs";
    maxMs: number;
  };
}

export interface RecordUndoCaseConfig extends RecordUndoRedoBaseCaseConfig {
  threshold: {
    metric: "undoReplay1kMs";
    maxMs: number;
  };
}

export interface RecordRedoCaseConfig extends RecordUndoRedoBaseCaseConfig {
  threshold: {
    metric: "redoReplay1kMs";
    maxMs: number;
  };
}

export interface RecordReorderCaseConfig extends RecordUndoRedoBaseCaseConfig {
  reorder: {
    blockStartOffset: number;
    blockSize: number;
    anchorOffset: number;
    position: "before" | "after";
  };
  threshold: {
    metric: "moveLast1kToFrontMs";
    maxMs: number;
  };
}

export const definePerfCase = <T extends PerfCase>(perfCase: T) => perfCase;
