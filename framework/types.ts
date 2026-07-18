import type { INestApplication } from "@nestjs/common";
import type { IFieldRo } from "@teable/core";

// Single source of truth for the runner <-> config binding. PerfRunnerKind is
// the keys of this map, and PerfCase (below) is discriminated on `runner`, so a
// case that pairs a runner with the wrong config shape fails `pnpm check:types`
// at the case file itself — instead of compiling clean and blowing up later when
// a driver reads a field the config never had.
export interface PerfCaseConfigByRunner {
  "http-endpoint": HttpEndpointCaseConfig;
  "formula-table": FormulaTableCaseConfig;
  "conditional-lookup": ConditionalLookupCaseConfig;
  "conditional-rollup": ConditionalRollupCaseConfig;
  "conditional-query": ConditionalQueryCaseConfig;
  "link-computed-propagation": LinkComputedPropagationCaseConfig;
  "computed-chain-mutation": ComputedChainMutationCaseConfig;
  "customer-upsert-computed-flow": CustomerUpsertComputedFlowCaseConfig;
  "lookup-search-index": LookupSearchIndexCaseConfig;
  "field-create": FieldCreateCaseConfig;
  "field-convert": FieldConvertCaseConfig;
  "field-convert-link": FieldConvertLinkCaseConfig;
  "field-update": FieldUpdateCaseConfig;
  "field-delete": FieldDeleteCaseConfig;
  "field-restore": FieldRestoreCaseConfig;
  "field-duplicate": FieldDuplicateCaseConfig;
  "duplicate-table": DuplicateTableCaseConfig;
  "duplicate-view": DuplicateViewCaseConfig;
  "duplicate-base": DuplicateBaseCaseConfig;
  "import-base": ImportBaseCaseConfig;
  "record-delete-link": RecordDeleteLinkCaseConfig;
  "table-create": TableCreateCaseConfig;
  "table-delete": TableDeleteCaseConfig;
  "table-delete-link": TableDeleteLinkCaseConfig;
  "table-restore": TableRestoreCaseConfig;
  "table-restore-link": TableRestoreLinkCaseConfig;
  "csv-import": CsvImportCaseConfig;
  "form-submit": FormSubmitCaseConfig;
  "record-paste": RecordPasteCaseConfig;
  "record-read": RecordReadCaseConfig;
  "record-create": RecordCreateCaseConfig;
  "record-update": RecordUpdateCaseConfig;
  "record-update-attachment": RecordUpdateAttachmentCaseConfig;
  "record-update-link": RecordUpdateLinkCaseConfig;
  "record-reorder": RecordReorderCaseConfig;
  "record-delete": RecordDeleteCaseConfig;
  "record-delete-stream": RecordDeleteStreamCaseConfig;
  "record-undo": RecordUndoCaseConfig;
  "record-redo": RecordRedoCaseConfig;
  "selection-clear": SelectionClearCaseConfig;
  "selection-duplicate": SelectionDuplicateCaseConfig;
  "record-duplicate-single": RecordDuplicateSingleCaseConfig;
}

export type PerfRunnerKind = keyof PerfCaseConfigByRunner;

interface PerfCaseBase {
  id: string;
  title: string;
  timeoutMs: number;
  // Opt-in idle watchdog (see framework/watchdog.ts). When set, the case fails
  // fast with a clear diagnostic if the server makes no HTTP/SSE progress for
  // this many ms, instead of hanging until `timeoutMs`. Set it comfortably above
  // the longest single server round-trip a healthy run expects; only true
  // silence trips it. Leave unset to keep the legacy hang-until-timeout behavior.
  watchdogMs?: number;
  runtimeEnv?: Record<string, string | number | boolean>;
}

// A runner-specific view of a perf case. Keeping this relationship named lets
// the dispatch seam carry the runner literal and its config together instead
// of widening both back to the full PerfCase union.
export type PerfCaseFor<K extends PerfRunnerKind> = {
  [P in K]: PerfCaseBase & {
    runner: P;
    config: PerfCaseConfigByRunner[P];
  };
}[K];

// Discriminated on `runner`: each runner literal binds to its matching config
// from PerfCaseConfigByRunner, so a case that pairs the wrong two does not
// type-check. Generic framework code can use the full union, while dispatch
// code narrows through PerfCaseFor<K> without losing that relationship.
export type PerfCase = PerfCaseFor<PerfRunnerKind>;

export interface PerfRunContext {
  app: INestApplication;
  appUrl: string;
  cookie?: string;
  runId: string;
  engine: string;
  artifactDir?: string;
  // Present only while a case runs under the watchdog (see framework/watchdog.ts).
  // Aborted when the watchdog trips so signal-aware requests get cancelled. SSE
  // streams honor it automatically; non-SSE runners can forward it to axios.
  signal?: AbortSignal;
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

export interface ConditionalComputedSeedConfig {
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
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    fullScanPageSize?: number;
  };
}

export interface ConditionalLookupCaseConfig
  extends ConditionalComputedSeedConfig {
  lookup: {
    name: string;
    limit: number;
  };
  threshold: {
    metric: "conditionalLookupReadyMs";
    maxMs: number;
  };
}

export interface ConditionalRollupCaseConfig
  extends ConditionalComputedSeedConfig {
  rollup: {
    name: string;
    expression: "array_join({values})";
    limit: number;
  };
  threshold: {
    metric: "conditionalRollupReadyMs";
    maxMs: number;
  };
}

export type ConditionalQueryValueField = "text" | "amount" | "active";
export type ConditionalQueryFilterProfile = "group" | "group-and-active";
interface ConditionalQueryFieldBase {
  name: string;
  filter: ConditionalQueryFilterProfile;
  sort?: { field: "amount"; order: "asc" | "desc" };
  limit?: number;
}
type ConditionalQueryFieldConfig =
  | (ConditionalQueryFieldBase & {
      kind: "lookup";
      valueField: ConditionalQueryValueField;
    })
  | (ConditionalQueryFieldBase & {
      kind: "rollup";
      valueField: ConditionalQueryValueField;
      expression: "countall({values})";
    })
  | (ConditionalQueryFieldBase & {
      kind: "rollup";
      valueField: "amount";
      expression: "sum({values})" | "average({values})" | "max({values})";
    })
  | (ConditionalQueryFieldBase & {
      kind: "rollup";
      valueField: "text";
      expression: "array_join({values})";
    });

export interface ConditionalQueryBaseCaseConfig {
  baseId: "seed-base";
  sourceTableNamePrefix: string;
  hostTableNamePrefix: string;
  sourceRecordCount: number;
  hostRecordCount: number;
  groupCount: number;
  batchSize: number;
  generator: {
    type: "grouped-fanout";
    groupPrefix: string;
    sourceTextPrefix: string;
    hostKeyPrefix: string;
    permutation: { multiplier: number; offset: number };
  };
  field: ConditionalQueryFieldConfig;
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    fullScanPageSize?: number;
  };
}

export type ConditionalQueryMutationConfig =
  | {
      kind: "text-update";
      recordCount: number;
      updatedSuffix: string;
    }
  | {
      kind: "amount-update";
      recordCount: number;
      amountDelta: number;
    }
  | {
      kind: "active-flip";
      recordCount: number;
    };

export type ConditionalQueryCaseConfig = ConditionalQueryBaseCaseConfig &
  (
    | {
        mutation?: never;
        threshold: {
          metric: "conditionalQueryReadyMs";
          maxMs: number;
        };
      }
    | {
        mutation: ConditionalQueryMutationConfig;
        threshold: {
          metric: "conditionalQueryPropagationReadyMs";
          maxMs: number;
        };
      }
  );

// Mirrors (a bounded version of) the customer "orders" schema to stress the V2
// async-compute pipeline on a data write. The orders host table has two many-one
// links (registered `customer_id_fk` -> users, guest `gust_email_fk` -> guest),
// each fanning out into a full attribute set of lookups, a multi-level formula
// chain over those lookups, and a many-one `purchase_fk` into a downstream
// `purchase` table that rolls up and re-derives the orders' computed values
// (a second cross-table hop). The measured operation writes BOTH links for a
// deterministic order window (all rows by default). Bulk cases wait for every
// dependent lookup, formula, rollup, and downstream computed value; customer
// read-after-write cases can poll the mutated records through one concrete read
// API and verify the full cascade after the timer. Cases can gate either the
// end-to-end write-to-readable window or the post-write propagation window;
// both `linkWriteMs` and the non-primary readiness metric are still reported as
// diagnostics. All computed fields live in the seed; the foreign tables share
// `foreignRowCount`.
export interface LinkComputedPropagationCaseConfig {
  baseId: "seed-base";
  // first-link: orders seeded with no customer/guest link (closest to the
  // customer "new record first association" worst case). repoint: orders seeded
  // already linked, then re-pointed (every cell changes).
  mode: "first-link" | "repoint";
  ordersTableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  // Batch size for the measured link write. Kept smaller than `batchSize`
  // because the V1 synchronous path recomputes the whole dependency graph inside
  // the write request, and a large batch can exceed the server request timeout.
  writeBatchSize: number;
  foreignRowCount: number;
  foreignBatchSize: number;
  // Downstream purchase table: each purchase groups `groupSize` consecutive
  // orders and rolls up their computed values, forming the second cascade hop.
  purchase: {
    groupSize: number;
  };
  // Execute-only mutation window. Omit to keep the existing all-record write.
  // Partial first-link cases leave rows outside this deterministic window
  // unlinked; partial repoint cases leave them on their seed targets.
  mutation?: {
    startOffset?: number;
    recordCount: number;
  };
  link: {
    isOneWay: boolean;
    // Both map order row i to foreign row
    // ((i - 1) * multiplier + offset) % foreignRowCount + 1. Customer and guest
    // links use the same permutation. seedPermutation is the re-point seed
    // mapping (ignored in first-link mode); updatePermutation is the measured
    // write target mapping.
    seedPermutation: {
      multiplier: number;
      offset: number;
    };
    updatePermutation: {
      multiplier: number;
      offset: number;
    };
  };
  verify: {
    sampleRows: number[];
    // Existing bulk cases wait for the full orders + purchase cascade inside
    // the primary metric. Single-record customer-path cases can instead poll
    // the mutated record through either read API, then run the full cascade
    // verification after the primary timer stops.
    readinessReadPath?: "full-scan" | "get-record" | "get-records";
    fullScanPageSize?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric: "lookupReadyTotalMs" | "lookupPropagationMs";
    maxMs: number;
  };
}

// Three customer-shaped mutations share one deterministic dependency graph:
// 40 Users -> 4,000 Orders (100 consecutive orders per user) -> 400 Purchases
// (10 consecutive orders per purchase). Orders carry four lookups followed by
// five formula levels; Purchases roll up the final formula and derive one more
// formula. Each case edits exactly one field: either the head formula schema
// (with unchanged, added, replaced, or removed dependencies), one foreign
// single-select cell, or one foreign text cell.
export interface ComputedChainMutationCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  mutation:
    | "formula-expression"
    | "formula-dependency-add"
    | "formula-dependency-replace"
    | "formula-dependency-remove"
    | "foreign-select"
    | "foreign-first-name";
  // Foreign-cell mutations default to the collection endpoint used by the
  // original cases. Single-record variants keep the same graph and payload
  // but exercise PATCH /record/:recordId and its distinct V2 canary feature.
  recordWriteMode?: "bulk" | "single";
  userCount: number;
  orderCount: number;
  ordersPerUser: number;
  purchaseGroupSize: number;
  targetUserRow: number;
  batchSize: number;
  userBatchSize: number;
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    // User-cell cases turn the customer-reported empty read window into a hard
    // response-after-write threshold in addition to the primary total metric.
    maxPostResponseMs?: number;
  };
  threshold: {
    metric: "fullCascadeReadyTotalMs" | "firstOrderReadyTotalMs";
    maxMs: number;
  };
}

// Customer-import shaped Order writes, with an optional preceding User write,
// over a deterministic dependency graph: 40 Users -> 4,000 Orders -> 400
// Purchases. The primary measurement starts at the first execute write and ends
// when the target Order is readable with all ten lookups and five formula
// levels. Full-table controls run after that timer.
export interface CustomerUpsertComputedFlowCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  scenario:
    | "update-user-create-order"
    | "update-user-update-order"
    | "create-user-create-order"
    | "create-order-only"
    | "update-user-first-name-only-create-order"
    | "update-user-control-field-create-order"
    | "update-other-user-create-order";
  userCount: number;
  orderCount: number;
  ordersPerUser: number;
  purchaseGroupSize: number;
  targetUserRow: number;
  batchSize: number;
  userBatchSize: number;
  verify: {
    fullScanPageSize?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    maxPostOrderResponseMs: number;
    outboxPollIntervalMs: number;
  };
  threshold: {
    metric: "customerFlowReadyTotalMs";
    maxMs: number;
  };
}

// A type alias (not an interface) so it stays assignable to the seed cache's
// JsonValue config hash input, which relies on implicit index signatures.
export type LookupSearchKeywordConfig = {
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
};

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
  // Cases with identical populated base tables may share one runner-level
  // seed. The fields created by the measured operation remain execute-only.
  seedIdentity?: string;
  rowCount?: number;
  batchSize?: number;
  baseFields: Array<IFieldRo & { id?: string; name: string }>;
  field?: IFieldRo & { id?: string; name: string };
  fields?: Array<IFieldRo & { id?: string; name: string }>;
  // Opt-in keeps established cases on their aggregate trace step while a
  // matrix can select individual field-create requests.
  tracePerField?: boolean;
  generator?:
    | {
        type: "title-sequence";
        titlePrefix: string;
      }
    | {
        type: "numeric-sequence";
        titlePrefix: string;
      };
  verify: {
    optionCount?: number;
    sampleOptionIndexes?: number[];
    fullScanPageSize?: number;
    emptyCreatedFields?: boolean;
  };
  ready?: {
    metric: "computedBackfillReadyMs";
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric:
      | "singleSelectCreateOptionsMs"
      | "create19FieldsMs"
      | "create5SimpleFieldsMs"
      | "create5ComputedFieldsMs"
      | "createScalarFieldsMs";
    maxMs: number;
  };
}

export type FieldConvertExpectedKind =
  | "multiSelectJoinedText"
  | "singleSelectText"
  | "numberText"
  | "checkboxText"
  | "ratingText"
  | "longTextSingleLine"
  | "textNumberMixed"
  | "textSingleSelect"
  | "textMultipleSelect"
  | "textCheckboxMixed"
  | "textDateMixed"
  | "clearedValues"
  | "autoNumberSequence"
  | "numberRatingClamped"
  | "singleSelectChoicePruned"
  | "multipleSelectChoicePruned"
  | "aTimesBPlusC";

export interface FieldConvertCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "field-convert-mixed";
    titlePrefix: string;
  };
  convert: {
    sourceFieldName: string;
    target: {
      type: IFieldRo["type"];
      // For formula targets the expression uses {FieldName} placeholders that
      // the runner compiles to field ids before the convert request.
      options?: Record<string, unknown>;
    };
    expected: FieldConvertExpectedKind;
  };
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    fullScanPageSize?: number;
    targetOptionNames?: string[];
    targetRatingMax?: number;
    targetIsComputed?: boolean;
  };
  threshold: {
    metric:
      | "convertSelectToTextReadyMs"
      | "convertSingleSelectToTextReadyMs"
      | "convertNumberToTextReadyMs"
      | "convertCheckboxToTextReadyMs"
      | "convertRatingToTextReadyMs"
      | "convertLongTextToTextReadyMs"
      | "convertTextToNumberReadyMs"
      | "convertTextToSingleSelectReadyMs"
      | "convertTextToMultipleSelectReadyMs"
      | "convertTextToCheckboxReadyMs"
      | "convertTextToDateReadyMs"
      | "convertTextToAttachmentReadyMs"
      | "convertTextToAutoNumberReadyMs"
      | "convertNumberToRatingReadyMs"
      | "convertSingleSelectChoicesReadyMs"
      | "convertMultipleSelectChoicesReadyMs"
      | "convertTextToFormulaReadyMs";
    maxMs: number;
  };
}

export type FieldConvertLinkDirection = "link-to-text" | "text-to-link";

// Field convert between a populated many-one link field and single line text.
// Unlike the single-table field-convert runner, this needs a foreign table the
// link points at, so it owns a separate runner kind (mirroring the
// table-delete vs table-delete-link split). `link-to-text` freezes the linked
// display titles into plain text; `text-to-link` matches text values back to
// foreign primary titles and rebuilds real links.
export interface FieldConvertLinkCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  direction: FieldConvertLinkDirection;
  rowCount: number;
  batchSize: number;
  // Name of the field that is converted. For `link-to-text` it is seeded as a
  // many-one link field; for `text-to-link` it is seeded as single line text
  // holding the matching foreign primary titles.
  sourceFieldName: string;
  foreignTable: {
    rowCount: number;
    batchSize: number;
    // Foreign primary titles are `${keyPrefix}-<paddedRow>`; host source values
    // map to them through the permutation below.
    keyPrefix: string;
  };
  link: {
    isOneWay: boolean;
    // Maps host row i to foreign row ((i - 1) * multiplier + offset) % foreignRowCount + 1.
    permutation: {
      multiplier: number;
      offset: number;
    };
  };
  generator: {
    type: "field-convert-link";
    titlePrefix: string;
  };
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "convertLinkToTextReadyMs" | "convertTextToLinkReadyMs";
    maxMs: number;
  };
}

// Expected-value kinds for the field-update computed cascade chain. The
// runner derives each row's expected value locally from the row number and
// the rename state, so the case config expression text must stay in sync
// with the runner's expectation logic (same pattern as FormulaExpectedKind).
export type FieldUpdateComputedExpectedKind =
  | "statusTextMark"
  | "statusScore"
  | "statusScoreBucket";

export interface FieldUpdateComputedFieldConfig {
  name: string;
  // Formula expression with {FieldName} placeholders compiled to field ids
  // before the create request. May reference Status or earlier computed
  // fields in the list (fields are created in list order).
  expression: string;
  expected: FieldUpdateComputedExpectedKind;
}

// V2-only diagnostic workload: rename a single select option (id preserved)
// through the v2 UpdateFieldCommand path and wait for the dependent computed
// fields to recompute. The legacy updateFieldRoSchema cannot express select
// options, so the case skips on every engine except v2.
export interface FieldUpdateCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  select: {
    fieldName: string;
    // Fixed option names; row N gets optionNames[(N - 1) % optionNames.length].
    optionNames: string[];
    rename: {
      previous: string;
      next: string;
    };
  };
  computedFields: FieldUpdateComputedFieldConfig[];
  generator: {
    type: "select-option-cycle";
    titlePrefix: string;
  };
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "updateSelectOptionRenameCascadeReadyMs";
    maxMs: number;
  };
}

// Shared shape for helpers reused by both the conditional-lookup and
// field-duplicate runners; everything except the runner-specific threshold.
export type ConditionalLookupSharedConfig = Omit<
  ConditionalLookupCaseConfig,
  "threshold"
>;

export interface ConditionalLookupFieldDuplicateCaseConfig
  extends Omit<ConditionalLookupCaseConfig, "threshold"> {
  duplicate: {
    name: string;
  };
  threshold: {
    metric: "conditionalLookupDuplicateReadyMs";
    maxMs: number;
  };
}

export interface ScalarFieldDuplicateCaseConfig
  extends RecordUndoRedoBaseCaseConfig {
  mode: "scalar";
  duplicate: {
    sourceFieldName: string;
    name: string;
  };
  threshold: {
    metric: "duplicateScalarFieldMs";
    maxMs: number;
  };
}

export interface StructuredFieldDuplicateCaseConfig
  extends RecordUndoRedoBaseCaseConfig {
  mode: "structured";
  duplicate: {
    sourceFieldName: string;
    name: string;
  };
  threshold: {
    metric: "duplicateStructuredFieldMs";
    maxMs: number;
  };
}

export type StoredFieldDuplicateCaseConfig =
  | ScalarFieldDuplicateCaseConfig
  | StructuredFieldDuplicateCaseConfig;

export interface LinkFieldDuplicateCaseConfig
  extends RecordUndoRedoBaseCaseConfig {
  mode: "link";
  // Some relationship shapes may only have a runnable duplicate contract on
  // V2. Seed still runs through the bootstrap engine so CI can restore the
  // fixture before the V2 execute job; only execute returns a V1 skip artifact.
  v2Only?: {
    reason: string;
  };
  link: TableLifecycleLinkConfig & {
    relationship: LinkRelationshipKind;
    isOneWay: boolean;
  };
  duplicate: {
    sourceFieldName: string;
    name: string;
  };
  threshold: {
    metric: "duplicateLinkFieldMs";
    maxMs: number;
  };
}

export type FieldDuplicateCaseConfig =
  | ConditionalLookupFieldDuplicateCaseConfig
  | StoredFieldDuplicateCaseConfig
  | LinkFieldDuplicateCaseConfig;

export interface RecordPasteCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  seedRowCount?: number;
  seedFieldCount?: number;
  stream?: boolean;
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
    metric: "paste1kMs" | "paste10kMs" | "pasteExpand10kMs";
    maxMs: number;
  };
}

export interface FormSubmitCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  generator: {
    type: "mixed-form-submit";
    titlePrefix: string;
    payloadPrefix: string;
    valuePrefix: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "formSubmitP95Ms";
    maxMs: number;
  };
}

export interface DuplicateTableCaseConfig {
  baseId: "seed-base";
  sourceTableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  formulas?: Array<{
    name: string;
    expression: string;
    expected:
      | "amountTimesQuantity"
      | "amountPlusQuantity"
      | "percentTimes100"
      | "quantityPlusPercent"
      | "amountTimesPercent";
  }>;
  /**
   * Optional self manyMany link on the source table (exercises T6156 physical
   * path for self-links). Seeded after records: row i → row i+1 (wrap last→first).
   * Not included in row-value verification of base fields.
   */
  selfLink?: {
    name: string;
    isOneWay?: boolean;
    /** Override batch size for link cell updates (default 50). */
    batchSize?: number;
    /**
     * Cap how many records get self-link values during seed.
     * Full 10k two-way link updates blow past CI transaction + case timeouts;
     * a few hundred rows still exercises junction + cell jsonb bulk copy.
     */
    maxLinks?: number;
  };
  generator: {
    type: "mixed-duplicate-table";
    titlePrefix: string;
    payloadPrefix: string;
    valuePrefix: string;
  };
  duplicate: {
    namePrefix: string;
    includeRecords: boolean;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric: "duplicateTableRequestMs";
    maxMs: number;
  };
}

export interface DuplicateBaseCaseConfig {
  spaceId: "seed-space";
  operation?: "duplicate" | "duplicate-stream" | "export-stream";
  sourceBaseNamePrefix: string;
  mainTable: {
    name: string;
    rowCount: number;
    batchSize: number;
    generator: {
      titlePrefix: string;
      payloadPrefix: string;
      source?: string;
    };
  };
  linkedTable: {
    name: string;
    rowCount: number;
    batchSize: number;
    keyPrefix: string;
    // Maps linked row i to main row ((i - 1) * multiplier + offset) % mainRowCount + 1.
    // multiplier must be coprime with mainTable.rowCount so link targets are unique.
    permutation: {
      multiplier: number;
      offset: number;
    };
  };
  smallTable: {
    name: string;
    rowCount: number;
    valuePrefix: string;
  };
  workflows: {
    count: number;
    namePrefix: string;
  };
  duplicate: {
    namePrefix: string;
    withRecords: boolean;
  };
  verify: {
    mainSampleRows: number[];
    linkSampleRows: number[];
    fullScanPageSize?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
  };
  threshold: {
    metric:
      | "duplicateBaseRequestMs"
      | "duplicateBaseStreamMs"
      | "exportBaseStreamMs";
    maxMs: number;
  };
}

export interface DuplicateViewCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  samples: number;
  sourceViewName: string;
  view: {
    textFieldName: string;
    numberFieldName: string;
    selectFieldName: string;
    groupFieldName: string;
  };
  threshold: {
    metric: "duplicateViewP95Ms";
    maxMs: number;
  };
}

export interface ImportBaseCaseConfig {
  spaceId: "seed-space";
  sourceBaseNamePrefix: string;
  teaFile?: {
    path: string;
    fileName: string;
    contentType?: string;
  };
  tables: Array<{
    name: string;
    rowCount: number;
    batchSize: number;
    expectedFieldCount?: number;
    expectedViewCount?: number;
    generator: {
      titlePrefix: string;
      payloadPrefix: string;
      source?: string;
    };
  }>;
  workflows: {
    count: number;
    namePrefix: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
    mode?: "generated-records" | "structure-only";
    expectedTableCount?: number;
    expectedAppCount?: number;
  };
  threshold: {
    metric: "importBaseStreamMs";
    maxMs: number;
  };
}

export interface TableCreateCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  tableCount: number;
  fields: Array<IFieldRo & { id?: string; name: string }>;
  // When set, every createTable request carries this many inline records in
  // the request body, making the measured cost scale with record count.
  inlineRecords?: {
    count: number;
    titlePrefix: string;
  };
  verify?: {
    mode: "all-fields";
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric:
      | "createTables10xTotalMs"
      | "createTable1x1kRecordsMs"
      | "createTable1x5kRecordsMs";
    maxMs: number;
  };
}

export interface RecordReadCaseConfig {
  baseId: "seed-base";
  sourceTableNamePrefix: string;
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  pageSize: number;
  skip: number;
  simpleTextFieldCount: number;
  formulaFieldCount: number;
  lookupFieldCount: number;
  queryVariant?: {
    filters?: {
      conjunction: "and" | "or";
      items: Array<{
        fieldName: string;
        operator: "isNotEmpty" | "isGreater" | "isLessEqual";
        value: string | number | null;
      }>;
    };
    search?: {
      value: string;
      fieldName: string;
      hideNotMatchRow: true;
    };
    orderBy?: Array<{
      fieldName: string;
      order: "asc" | "desc";
    }>;
    groupBy?: Array<{
      fieldName: string;
      order: "asc" | "desc";
    }>;
    expectedRowCount: number;
  };
  generator: {
    type: "record-read-lookup-formula";
    titlePrefix: string;
    textPrefix: string;
    sourceKeyPrefix: string;
    sourceValuePrefix: string;
    permutation: {
      multiplier: number;
      offset: number;
    };
  };
  verify: {
    sampleRows: number[];
    timeoutMs?: number;
    pollIntervalMs?: number;
    fullScanPageSize?: number;
  };
  threshold: {
    metric:
      | "getRecords10kPagedScanMs"
      | "getRecords50kPagedScanMs"
      | "getRecordsQueryPagedScanMs"
      | "getRecordsFilterSortGroupByOverheadMs"
      | "getRecordsQueryOverheadMs";
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
  // Cases with identical empty-table fixtures may share one runner-level seed.
  // Payload selection stays execute-only so siblings can compare request width
  // without building duplicate table schemas.
  seedIdentity?: string;
  createFieldNames?: string[];
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
  // Cases with identical seed data may opt into a runner-level cache identity.
  // Payload selection is deliberately excluded so partial-update siblings can
  // reuse one fixture without conflating their measured requests.
  seedIdentity?: string;
  updateFieldNames?: string[];
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

// Bulk insert attachment references into existing records. Attachment cell
// values cannot be computed from the row number (each token must reference a
// real uploaded attachment), so the runner uploads a fixed deterministic file
// set during execute setup and then bulk-updates the records — its own runner
// kind rather than an extension of the scalar record-update runner.
export interface RecordUpdateAttachmentCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  attachmentFieldName: string;
  // Deterministic files uploaded once during execute setup (not measured) to
  // obtain valid attachment tokens the bulk update can reference.
  attachments: Array<{
    filename: string;
    content: string;
    mimetype: string;
  }>;
  // How many of the uploaded attachment items are inserted into every record's
  // cell during the measured bulk update (must be <= attachments.length).
  attachmentsPerCell: number;
  // The measured bulk-insert request is sampled this many times after one
  // warmup; the primary metric is the p95 over the samples. PERF_LAB_SAMPLES
  // overrides it at run time.
  samples: number;
  generator: {
    type: "attachment-record-update";
    titlePrefix: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric:
      | "bulkUpdate100AttachmentCellsP95Ms"
      | "bulkUpdate1kAttachmentCellsP95Ms";
    maxMs: number;
  };
}

// Bulk re-point many-one link cells across existing records. Needs a foreign
// table the link references, so it owns a runner kind (mirroring the
// table-delete vs table-delete-link split). The seed populates links through
// `seedPermutation`; the measured update rewrites them to `updatePermutation`.
export interface RecordUpdateLinkCaseConfig {
  baseId: "seed-base";
  tableNamePrefix: string;
  rowCount: number;
  batchSize: number;
  linkFieldName: string;
  foreignTable: {
    rowCount: number;
    batchSize: number;
    keyPrefix: string;
  };
  link: {
    isOneWay: boolean;
    // Both map host row i to foreign row ((i - 1) * multiplier + offset) % foreignRowCount + 1.
    seedPermutation: {
      multiplier: number;
      offset: number;
    };
    updatePermutation: {
      multiplier: number;
      offset: number;
    };
  };
  generator: {
    type: "link-record-update";
    titlePrefix: string;
  };
  verify: {
    sampleRows: number[];
    fullScanPageSize?: number;
  };
  threshold: {
    metric: "bulkUpdate1kLinkCellsMs";
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
    metric: "clear1kMs" | "clear10kMs";
    maxMs: number;
  };
}

export interface DuplicateRecordSeedBaseCaseConfig {
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
}

export interface SelectionDuplicateCaseConfig
  extends DuplicateRecordSeedBaseCaseConfig {
  duplicate: {
    startRowOffset: number;
    rowCount: number;
  };
  threshold: {
    metric: "duplicateBlock1kMs";
    maxMs: number;
  };
}

export interface RecordDuplicateSingleCaseConfig
  extends DuplicateRecordSeedBaseCaseConfig {
  duplicate: {
    sourceRowCount: number;
  };
  threshold: {
    metric: "duplicateSingleP95Ms";
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

export interface FieldDeleteCaseConfig extends RecordUndoRedoBaseCaseConfig {
  delete: {
    fieldNames: string[];
  };
  threshold: {
    metric: "delete19FieldsMs" | "deleteFieldMs";
    maxMs: number;
  };
}

export interface FieldRestoreCaseConfig extends RecordUndoRedoBaseCaseConfig {
  restore: {
    fieldName: string;
  };
  threshold: {
    metric: "restoreFieldMs";
    maxMs: number;
  };
}

export interface TableDeleteCaseConfig extends RecordUndoRedoBaseCaseConfig {
  samples: number;
  samplesMode?: "environment" | "fixed";
  threshold: {
    metric: "deleteTableP95Ms";
    maxMs: number;
  };
}

export interface TableRestoreCaseConfig extends RecordUndoRedoBaseCaseConfig {
  samples: number;
  samplesMode?: "environment" | "fixed";
  threshold: {
    metric: "restoreTableP95Ms";
    maxMs: number;
  };
}

export type LinkRelationshipKind =
  | "manyMany"
  | "oneMany"
  | "manyOne"
  | "oneOne";

// A populated link field on the main table pointing at a deterministic foreign
// table. Lifecycle cases use the default one-way many-one shape; callers that
// exercise relationship behavior can opt into another relationship explicitly.
// A type alias (not an interface) so it stays assignable to the seed cache's
// JsonValue config hash input, which relies on implicit index signatures.
export type TableLifecycleLinkConfig = {
  fieldName: string;
  relationship?: LinkRelationshipKind;
  isOneWay?: boolean;
  foreignTable: {
    rowCount: number;
    batchSize: number;
    keyPrefix: string;
  };
  // Maps main row i to foreign row ((i - 1) * multiplier + offset) % foreignRowCount + 1.
  permutation: {
    multiplier: number;
    offset: number;
  };
};

// Archive the foreign table while the 10k-record main table still links to
// it: v1 soft delete runs detachLink, converting the surviving link field
// cell-by-cell (O(main rowCount)); v2 soft delete skips that side effect.
export interface TableDeleteLinkCaseConfig
  extends RecordUndoRedoBaseCaseConfig {
  samples: number;
  samplesMode?: "environment" | "fixed";
  link: TableLifecycleLinkConfig;
  threshold: {
    metric: "deleteTableDetachLinkP95Ms" | "deleteTableDetachLink30kMs";
    maxMs: number;
  };
}

// Restore a 10k-record table that owns a populated link field: today both
// engines flip metadata only, so this is a sentinel that fires if restore
// ever gains record-dependent work (link re-attachment, recompute, ...).
export interface TableRestoreLinkCaseConfig
  extends RecordUndoRedoBaseCaseConfig {
  samples: number;
  samplesMode?: "environment" | "fixed";
  link: TableLifecycleLinkConfig;
  threshold: {
    metric: "restoreTableP95Ms";
    maxMs: number;
  };
}

export interface RecordDeleteCaseConfig extends RecordUndoRedoBaseCaseConfig {
  threshold: {
    metric: "delete1kMs";
    maxMs: number;
  };
}

export interface RecordDeleteLinkCaseConfig
  extends RecordUndoRedoBaseCaseConfig {
  link: TableLifecycleLinkConfig;
  threshold: {
    metric: "deleteLinked1kMs";
    maxMs: number;
  };
}

// Streaming sibling of record-delete. The grid streams any selection delete
// over ~200 effective rows; the sync record-delete runner only exercises the
// small-selection path. Same user behavior ("delete the whole selection"),
// each engine driving the endpoint its own grid uses: V1 → range
// GET /selection/delete-stream (legacy range stream), V2 → by-id
// PATCH /selection/delete-by-id-stream. Both legs are @UseV2Feature('deleteRecord').
export interface RecordDeleteStreamCaseConfig
  extends RecordUndoRedoBaseCaseConfig {
  threshold: {
    metric: "deleteStream1kMs" | "deleteStream10kMs" | "deleteStream30kMs";
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

// Generic so the return type keeps the case's specific config variant: a few
// cases build on a sibling by spreading `baseCase.config`, which only works if
// that property is the narrow member config, not the whole union. The constraint
// `T extends PerfCase` is what enforces the binding now that PerfCase is
// discriminated on `runner` — a runner paired with the wrong config no longer
// satisfies the constraint and fails `pnpm check:types`. (No `const`: `id`/
// `title` stay `string`, so the registry's case-id map stays open.)
export const definePerfCase = <T extends PerfCase>(perfCase: T): T => perfCase;
