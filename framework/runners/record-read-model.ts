import type { RecordReadCaseConfig } from "../types";

export type ResolvedField = {
  id: string;
  name: string;
  type?: string;
};

export type FieldModel = {
  name: string;
  type: "singleLineText" | "number";
};

export const RECORD_READ_FIXTURE_VERSION = "record-read-v1";
export const SOURCE_KEY_FIELD_NAME = "Source Key";
export const HOST_LOOKUP_KEY_FIELD_NAME = "Lookup Source Key";
export const BASE_NUMBER_FIELDS = ["A", "B", "C"] as const;

export const selectRecordReadPrimaryMetricValue = ({
  metric,
  queryDurationMs,
  overheadMs,
}: {
  metric: RecordReadCaseConfig["threshold"]["metric"];
  queryDurationMs?: number;
  overheadMs?: number;
}) => {
  const isOverheadMetric =
    metric === "getRecordsQueryOverheadMs" ||
    metric === "getRecordsFilterSortGroupByOverheadMs";
  if (isOverheadMetric) {
    return overheadMs == null ? undefined : Math.max(overheadMs, 0);
  }
  return queryDurationMs;
};

export const getRecordReadPageCount = (
  expectedRecordCount: number,
  pageSize: number,
) => Math.max(1, Math.ceil(expectedRecordCount / pageSize));

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(5, "0");

export const sourceValueName = (index: number) => `Source Value ${index}`;
export const hostTextName = (index: number) => `Text ${index}`;
export const formulaName = (index: number) => `Formula ${index}`;
export const lookupName = (index: number) => `Lookup Value ${index}`;

export const getSourceValueNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.lookupFieldCount }, (_, index) =>
    sourceValueName(index + 1),
  );

export const getHostTextNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.simpleTextFieldCount }, (_, index) =>
    hostTextName(index + 1),
  );

export const getFormulaNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.formulaFieldCount }, (_, index) =>
    formulaName(index + 1),
  );

export const getLookupNames = (config: RecordReadCaseConfig) =>
  Array.from({ length: config.lookupFieldCount }, (_, index) =>
    lookupName(index + 1),
  );

export const getSourceFieldNames = (config: RecordReadCaseConfig) => [
  SOURCE_KEY_FIELD_NAME,
  ...getSourceValueNames(config),
];

export const getHostBaseFieldNames = (config: RecordReadCaseConfig) => [
  "Title",
  HOST_LOOKUP_KEY_FIELD_NAME,
  ...BASE_NUMBER_FIELDS,
  ...getHostTextNames(config),
];

export const getProjectionFieldNames = (config: RecordReadCaseConfig) => [
  ...getHostBaseFieldNames(config),
  ...getFormulaNames(config),
  ...getLookupNames(config),
];

const gcd = (left: number, right: number): number =>
  right === 0 ? Math.abs(left) : gcd(right, left % right);

export const assertConfigShape = (config: RecordReadCaseConfig) => {
  const projectionFieldCount = getProjectionFieldNames(config).length;
  if (projectionFieldCount !== 50) {
    throw new Error(
      `record-read case must project exactly 50 fields, got ${projectionFieldCount}`,
    );
  }
  if (config.pageSize > 1_000) {
    throw new Error(
      `record-read pageSize ${config.pageSize} exceeds the getRecords max of 1000`,
    );
  }
  if (config.rowCount % config.pageSize !== 0) {
    throw new Error(
      `record-read rowCount=${config.rowCount} must be divisible by pageSize=${config.pageSize}`,
    );
  }
  if (gcd(config.generator.permutation.multiplier, config.rowCount) !== 1) {
    throw new Error(
      `record-read permutation multiplier ${config.generator.permutation.multiplier} must be coprime with rowCount=${config.rowCount}`,
    );
  }
  const queryVariant = config.queryVariant;
  if (!queryVariant) {
    return;
  }

  const clauses = [
    ...(queryVariant.filters?.items.map((item) => item.fieldName) ?? []),
    ...(queryVariant.search ? [queryVariant.search.fieldName] : []),
    ...(queryVariant.orderBy?.map((item) => item.fieldName) ?? []),
    ...(queryVariant.groupBy?.map((item) => item.fieldName) ?? []),
  ];
  if (clauses.length === 0) {
    throw new Error(
      "record-read query variant must define at least one clause",
    );
  }
  const projectionFieldNames = getProjectionFieldNames(config);
  for (const fieldName of clauses) {
    if (!projectionFieldNames.includes(fieldName)) {
      throw new Error(
        `record-read query variant references missing projection field ${fieldName}`,
      );
    }
  }
  if (
    queryVariant.expectedRowCount < 0 ||
    queryVariant.expectedRowCount > config.rowCount
  ) {
    throw new Error(
      `record-read query variant expectedRowCount must be between 0 and ${config.rowCount}, got ${queryVariant.expectedRowCount}`,
    );
  }
  if (queryVariant.filters && queryVariant.filters.items.length === 0) {
    throw new Error("record-read query variant filters must not be empty");
  }
  if (queryVariant.orderBy && queryVariant.orderBy.length === 0) {
    throw new Error("record-read query variant orderBy must not be empty");
  }
  if (queryVariant.groupBy && queryVariant.groupBy.length === 0) {
    throw new Error("record-read query variant groupBy must not be empty");
  }

  const storedHostFieldNames = new Set([
    "Title",
    HOST_LOOKUP_KEY_FIELD_NAME,
    ...BASE_NUMBER_FIELDS,
    ...getHostTextNames(config),
  ]);
  for (const group of queryVariant.groupBy ?? []) {
    if (!storedHostFieldNames.has(group.fieldName)) {
      throw new Error(
        `record-read query variant groupBy field must be a stored host field, got ${group.fieldName}`,
      );
    }
  }
};

export const getSourceRowNumberForHostRow = (
  hostRowNumber: number,
  config: RecordReadCaseConfig,
) =>
  (((hostRowNumber - 1) * config.generator.permutation.multiplier +
    config.generator.permutation.offset) %
    config.rowCount) +
  1;

export const getSourceKey = (rowNumber: number, config: RecordReadCaseConfig) =>
  `${config.generator.sourceKeyPrefix}-${padRowNumber(rowNumber)}`;

export const getSourceValue = (
  rowNumber: number,
  sourceValueIndex: number,
  config: RecordReadCaseConfig,
) =>
  `${config.generator.sourceValuePrefix}-${sourceValueIndex}-${padRowNumber(
    rowNumber,
  )}`;

export const getHostTextValue = (
  rowNumber: number,
  textIndex: number,
  config: RecordReadCaseConfig,
) => `${config.generator.textPrefix}-${textIndex}-${padRowNumber(rowNumber)}`;

export const getBaseNumberValue = (
  fieldName: (typeof BASE_NUMBER_FIELDS)[number],
  rowNumber: number,
) => {
  switch (fieldName) {
    case "A":
      return rowNumber;
    case "B":
      return ((rowNumber - 1) % 100) + 1;
    case "C":
      return ((rowNumber - 1) % 7) + 1;
  }
};

export const getFormulaExpression = (formulaIndex: number) => {
  switch (formulaIndex) {
    case 1:
      return "{A} + {B} + {C}";
    case 2:
      return "({A} * {C}) + {B}";
    case 3:
      return "{A} + ({B} * {C})";
    case 4:
      return "({A} * 3) + ({B} * 5) + ({C} * 7)";
    case 5:
      return "({A} * {B}) + {C}";
    default:
      throw new Error(`Unsupported record-read formula index ${formulaIndex}`);
  }
};

export const getFormulaExpectedValue = (
  formulaIndex: number,
  rowNumber: number,
) => {
  const A = getBaseNumberValue("A", rowNumber);
  const B = getBaseNumberValue("B", rowNumber);
  const C = getBaseNumberValue("C", rowNumber);
  switch (formulaIndex) {
    case 1:
      return A + B + C;
    case 2:
      return A * C + B;
    case 3:
      return A + B * C;
    case 4:
      return A * 3 + B * 5 + C * 7;
    case 5:
      return A * B + C;
    default:
      throw new Error(`Unsupported record-read formula index ${formulaIndex}`);
  }
};

export const buildSourceRecordFields = (
  rowNumber: number,
  config: RecordReadCaseConfig,
) => {
  const fields: Record<string, unknown> = {
    [SOURCE_KEY_FIELD_NAME]: getSourceKey(rowNumber, config),
  };
  for (let index = 1; index <= config.lookupFieldCount; index += 1) {
    fields[sourceValueName(index)] = getSourceValue(rowNumber, index, config);
  }
  return fields;
};

export const buildHostRecordFields = (
  rowNumber: number,
  config: RecordReadCaseConfig,
) => {
  const sourceRowNumber = getSourceRowNumberForHostRow(rowNumber, config);
  const fields: Record<string, unknown> = {
    Title: `${config.generator.titlePrefix}-${padRowNumber(rowNumber)}`,
    [HOST_LOOKUP_KEY_FIELD_NAME]: getSourceKey(sourceRowNumber, config),
  };
  for (const fieldName of BASE_NUMBER_FIELDS) {
    fields[fieldName] = getBaseNumberValue(fieldName, rowNumber);
  }
  for (let index = 1; index <= config.simpleTextFieldCount; index += 1) {
    fields[hostTextName(index)] = getHostTextValue(rowNumber, index, config);
  }
  return fields;
};

export const getExpectedValue = (
  fieldName: string,
  rowNumber: number,
  config: RecordReadCaseConfig,
) => {
  if (fieldName === "Title") {
    return `${config.generator.titlePrefix}-${padRowNumber(rowNumber)}`;
  }
  if (fieldName === HOST_LOOKUP_KEY_FIELD_NAME) {
    return getSourceKey(
      getSourceRowNumberForHostRow(rowNumber, config),
      config,
    );
  }
  if ((BASE_NUMBER_FIELDS as readonly string[]).includes(fieldName)) {
    return getBaseNumberValue(
      fieldName as (typeof BASE_NUMBER_FIELDS)[number],
      rowNumber,
    );
  }
  const textMatch = fieldName.match(/^Text (\d+)$/);
  if (textMatch) {
    return getHostTextValue(rowNumber, Number(textMatch[1]), config);
  }
  const formulaMatch = fieldName.match(/^Formula (\d+)$/);
  if (formulaMatch) {
    return getFormulaExpectedValue(Number(formulaMatch[1]), rowNumber);
  }
  const lookupMatch = fieldName.match(/^Lookup Value (\d+)$/);
  if (lookupMatch) {
    const sourceRowNumber = getSourceRowNumberForHostRow(rowNumber, config);
    return [getSourceValue(sourceRowNumber, Number(lookupMatch[1]), config)];
  }
  throw new Error(`No expected value rule for record-read field ${fieldName}`);
};

export const valuesMatch = (expected: unknown, actual: unknown) => {
  if (typeof expected === "number") {
    return Number(actual) === expected;
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
};

export const parseRowNumberFromTitle = (
  value: unknown,
  config: RecordReadCaseConfig,
) => {
  if (typeof value !== "string") {
    throw new Error(`Expected string title value, got ${String(value)}`);
  }
  const prefix = `${config.generator.titlePrefix}-`;
  if (!value.startsWith(prefix)) {
    throw new Error(`Unexpected title value ${value}`);
  }
  const rowNumber = Number(value.slice(prefix.length));
  if (!Number.isInteger(rowNumber) || rowNumber < 1) {
    throw new Error(`Could not parse row number from title ${value}`);
  }
  return rowNumber;
};

export const resolveFieldIds = (
  fields: Array<{ id: string; name: string; type?: string }>,
  requiredNames: string[],
  tableId: string,
) => {
  const fieldByName = new Map(fields.map((field) => [field.name, field]));
  const missing = requiredNames.filter((name) => !fieldByName.has(name));
  if (missing.length > 0) {
    throw new Error(
      `Missing fields on ${tableId}: ${missing.join(
        ", ",
      )}; available=${fields.map((field) => field.name).join(", ")}`,
    );
  }
  return new Map(
    requiredNames.map((name) => {
      const field = fieldByName.get(name)!;
      return [name, field.id];
    }),
  );
};

export const compileExpression = (
  expression: string,
  fieldIdByName: Map<string, string>,
) =>
  expression.replace(/\{([^}]+)\}/g, (match, fieldName: string) => {
    const fieldId = fieldIdByName.get(fieldName);
    return fieldId ? `{${fieldId}}` : match;
  });

export const buildSourceFieldModels = (config: RecordReadCaseConfig) =>
  getSourceFieldNames(config).map((name) => ({
    name,
    type: "singleLineText" as const,
  }));

export const buildHostBaseFieldModels = (config: RecordReadCaseConfig) => [
  { name: "Title", type: "singleLineText" as const },
  { name: HOST_LOOKUP_KEY_FIELD_NAME, type: "singleLineText" as const },
  ...BASE_NUMBER_FIELDS.map((name) => ({ name, type: "number" as const })),
  ...getHostTextNames(config).map((name) => ({
    name,
    type: "singleLineText" as const,
  })),
];
