import { DEFAULT_TABLE_DATA_SAFETY_LIMITS, MAX_RECORDS_LIMIT } from '@teable/v2-core';

import { sha256Hex } from '../case/canonicalJson';
import type { BenchDatasetRecipe, BenchOracle, BenchWorkloadStep } from '../case/manifest';
import { generateTableRows } from '../dataset/recipe';
import type { GeneratorTemplate } from '../generator/generate';
import type { Scenario } from './schema';

type CheckBody =
  | { kind: 'row-count'; table: string; expected: number }
  | { kind: 'field-values'; table: string; field?: string; expected: unknown }
  | { kind: 'full-recompute'; tables: ReadonlyArray<string>; maxRows?: number }
  | {
      kind: 'query-record-ids';
      operations: ReadonlyArray<string>;
      expectedTotal?: number;
      table?: string;
    }
  | {
      kind: 'query-values';
      operations: ReadonlyArray<string>;
      expected: unknown;
      ordered?: boolean;
    };

/** The limits advertised by the headless runtime's public command/query contracts. */
export const CATALOGUE_API_BATCH_LIMIT =
  DEFAULT_TABLE_DATA_SAFETY_LIMITS.recordValues.maxRecordsPerMutation;
export const CATALOGUE_API_PAGE_LIMIT = MAX_RECORDS_LIMIT;

const grid = [{ type: 'grid', name: 'Grid' }];

const semanticStructure = {
  tables: [
    {
      id: 'tblcatalogQueryWrt',
      name: 'Records',
      fields: [
        { id: 'fldcatalogQWTitle', name: 'Title', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogQWAmoun', name: 'Amount', type: 'number' },
        { id: 'fldcatalogQWSortK', name: 'SortKey', type: 'number' },
        {
          id: 'fldcatalogQWRatin',
          name: 'Rating',
          type: 'rating',
          options: { max: 5, icon: 'star', color: 'yellowBright' },
        },
        { id: 'fldcatalogQWNoise', name: 'Noise', type: 'number' },
      ],
      views: grid,
    },
  ],
};

function normalizedStructure(): unknown {
  const tableId = `tbl${sha256Hex(semanticStructure.tables[0]!.id).slice(0, 16)}`;
  return {
    tables: semanticStructure.tables.map((table) => ({
      ...table,
      id: tableId,
      fields: table.fields.map((field) => ({
        ...field,
        id: `fld${sha256Hex(field.id).slice(0, 16)}`,
      })),
    })),
  };
}

function profileRecipe(scenario: Scenario): BenchDatasetRecipe['tables'][string]['fields'] {
  const cardinality = { low: 4, medium: 20, high: 100 }[scenario.profile.cardinality];
  const distribution =
    scenario.profile.distribution === 'hotspot'
      ? 'clustered'
      : scenario.profile.distribution === 'sparse'
        ? 'uniform'
        : scenario.profile.distribution;
  return {
    Title: { width: scenario.profile.textWidth },
    Noise: {
      distribution,
      cardinality,
      min: 0,
      max: cardinality,
      ...(scenario.profile.distribution === 'sparse' ? { nullFraction: 0.8 } : {}),
    },
  };
}

function dataset(scenario: Scenario, sortNullFraction = 0): BenchDatasetRecipe {
  return {
    tables: {
      Records: {
        fields: {
          ...profileRecipe(scenario),
          Amount: { distribution: 'constant', min: 7, max: 7 },
          SortKey: {
            distribution: 'clustered',
            cardinality: 4,
            min: 0,
            max: 4,
            ...(sortNullFraction === 0 ? {} : { nullFraction: sortNullFraction }),
          },
          Rating: { distribution: 'constant', min: 3, max: 3 },
        },
      },
    },
  };
}

function check(
  scenario: Scenario,
  key: string,
  description: string,
  body: CheckBody
): BenchWorkloadStep {
  return {
    key: `${key}-checkpoint`,
    kind: 'checkpoint',
    check: {
      ...body,
      checkId: `${scenario.scenarioId}/${key}`,
      description,
      obligationIds: [...scenario.coverageObligationKeys],
    },
  };
}

function rowCountCheck(
  scenario: Scenario,
  key: string,
  description: string,
  expected: number
): BenchWorkloadStep {
  return check(scenario, key, description, {
    kind: 'row-count',
    table: 'Records',
    expected,
  });
}

function valuesCheck(
  scenario: Scenario,
  key: string,
  description: string,
  field: string,
  expected: unknown
): BenchWorkloadStep {
  return check(scenario, key, description, {
    kind: 'field-values',
    table: 'Records',
    field,
    expected,
  });
}

function queryCheck(
  scenario: Scenario,
  key: string,
  description: string,
  operation: string,
  expectedTotal: number,
  wholeTable = false
): BenchWorkloadStep {
  return check(scenario, key, description, {
    kind: 'query-record-ids',
    operations: [operation],
    expectedTotal,
    ...(wholeTable ? { table: 'Records' } : {}),
  });
}

function queryValuesCheck(
  scenario: Scenario,
  key: string,
  description: string,
  operation: string,
  expected: ReadonlyArray<Readonly<Record<string, unknown>>>
): BenchWorkloadStep {
  return check(scenario, key, description, {
    kind: 'query-values',
    operations: [operation],
    expected,
    ordered: true,
  });
}

function generatedRows(scenario: Scenario, sortNullFraction = 0) {
  return generateTableRows({
    table: 'Records',
    rows: scenario.size.rows,
    fields: {
      Title: { type: 'singleLineText', isComputed: false, isPrimary: true },
      Amount: { type: 'number', isComputed: false },
      SortKey: { type: 'number', isComputed: false },
      Rating: { type: 'rating', isComputed: false },
      Noise: { type: 'number', isComputed: false },
    },
    recipe: dataset(scenario, sortNullFraction).tables.Records,
    targetRowCounts: { Records: scenario.size.rows },
    seed: 7,
    actorId: 'usr_headless',
  });
}

function expectedError(
  scenario: Scenario,
  input: {
    key: string;
    description: string;
    expectedCode: string;
    unchanged?: { field: string; rows: number };
    step: Extract<BenchWorkloadStep, { kind: 'query-core' | 'write-create' | 'write-update' }>;
  }
): BenchWorkloadStep {
  const { key, description, expectedCode, unchanged, step } = input;
  return {
    key,
    kind: 'expect-error',
    checkId: `${scenario.scenarioId}/${key}`,
    description,
    obligationIds: [...scenario.coverageObligationKeys],
    expectedCode,
    ...(unchanged
      ? {
          unchanged: {
            table: 'Records',
            field: unchanged.field,
            selection: 'first' as const,
            rows: unchanged.rows,
          },
        }
      : {}),
    step: (({ key: _nestedKey, ...nested }) => nested)(step),
  };
}

function finalOracle(scenario: Scenario, expectedRows?: number): ReadonlyArray<BenchOracle> {
  return [
    {
      key: 'catalogue-query-write-final',
      kind: 'invariant',
      checkId: `${scenario.scenarioId}/final`,
      description: scenario.oracle.expected,
      obligationIds: [...scenario.coverageObligationKeys],
      checks: [
        { type: 'unique-primary', table: 'Records' },
        ...(expectedRows === undefined
          ? []
          : [{ type: 'row-count' as const, table: 'Records', expected: expectedRows }]),
      ],
    },
  ];
}

function template(
  scenario: Scenario,
  workload: ReadonlyArray<BenchWorkloadStep>,
  options: { sortNullFraction?: number; expectedRows?: number } = {}
): GeneratorTemplate {
  return {
    id: scenario.fixture.reference,
    rootTable: 'Records',
    structure: normalizedStructure(),
    dataset: dataset(scenario, options.sortNullFraction),
    workload,
    oracle: finalOracle(scenario, options.expectedRows),
  };
}

function stableSortTemplate(scenario: Scenario): GeneratorTemplate {
  const oneColumn = 'transition-1-sort-one-column';
  const twoColumns = 'transition-2-sort-two-columns';
  const source = generatedRows(scenario, 0.2);
  const nullFirst = (left: (typeof source)[number], right: (typeof source)[number]) => {
    const leftKey = left.fields.SortKey;
    const rightKey = right.fields.SortKey;
    if (leftKey === null) return rightKey === null ? left.index - right.index : -1;
    if (rightKey === null) return 1;
    const difference = Number(leftKey) - Number(rightKey);
    return difference === 0 ? left.index - right.index : difference;
  };
  const oneColumnExpected = [...source].sort(nullFirst).map((row) => ({
    Title: row.fields.Title,
    SortKey: row.fields.SortKey,
  }));
  const twoColumnsExpected = [...source]
    .sort((left, right) => {
      const byKey = nullFirst(left, right);
      if (left.fields.SortKey !== right.fields.SortKey) return byKey;
      return String(right.fields.Title).localeCompare(String(left.fields.Title));
    })
    .map((row) => ({ Title: row.fields.Title, SortKey: row.fields.SortKey }));
  return template(
    scenario,
    [
      {
        key: oneColumn,
        kind: 'query-core',
        table: 'Records',
        query: {
          sort: [{ fieldId: 'SortKey', order: 'asc' }],
          projection: ['Title', 'SortKey'],
          limit: Math.max(1, scenario.size.rows),
          includeTotal: true,
        },
      },
      queryValuesCheck(
        scenario,
        'transition-1',
        scenario.workload.mutationSequence[0]!,
        oneColumn,
        oneColumnExpected
      ),
      {
        key: twoColumns,
        kind: 'query-core',
        table: 'Records',
        query: {
          sort: [
            { fieldId: 'SortKey', order: 'asc' },
            { fieldId: 'Title', order: 'desc' },
          ],
          projection: ['Title', 'SortKey'],
          limit: Math.max(1, scenario.size.rows),
          includeTotal: true,
        },
      },
      queryValuesCheck(
        scenario,
        'transition-2',
        scenario.workload.mutationSequence[1]!,
        twoColumns,
        twoColumnsExpected
      ),
    ],
    { sortNullFraction: 0.2 }
  );
}

function structuredQueryTemplate(scenario: Scenario): GeneratorTemplate {
  const operation = 'transition-1-structured-query';
  const offset = Math.min(5, scenario.size.rows);
  const source = generatedRows(scenario);
  const expected = [...source]
    .filter((row) => Number(row.fields.Amount) > 6)
    .sort((left, right) => String(left.fields.Title).localeCompare(String(right.fields.Title)))
    .slice(offset, offset + 10)
    .map((row) => ({ title: row.fields.Title, amount: row.fields.Amount }));
  return template(scenario, [
    {
      key: operation,
      kind: 'query-structured',
      definition: {
        version: 1,
        kind: 'records',
        tableId: 'Records',
        filter: { fieldId: 'Amount', operator: 'isGreater', value: 6 },
        sort: [
          { fieldId: 'Amount', order: 'desc' },
          { fieldId: 'Title', order: 'asc' },
        ],
        page: { limit: 10, offset, includeTotal: true },
        select: [
          { fieldId: 'Title', alias: 'title' },
          { fieldId: 'Amount', alias: 'amount' },
        ],
      },
    },
    queryValuesCheck(
      scenario,
      'transition-1',
      scenario.workload.mutationSequence[0]!,
      operation,
      expected
    ),
  ]);
}

function invalidTypecastTemplate(scenario: Scenario): GeneratorTemplate {
  const rows = scenario.size.rows;
  const allSevens = Array.from({ length: rows }, () => 7);
  return template(scenario, [
    valuesCheck(
      scenario,
      'transition-1-amount',
      `${scenario.workload.mutationSequence[0]!}：数字原值`,
      'Amount',
      allSevens
    ),
    expectedError(scenario, {
      key: 'transition-2-reject-unconvertible-text',
      description: `${scenario.workload.mutationSequence[1]!}：拒绝不可转换文本`,
      expectedCode: 'validation.field.invalid_value',
      unchanged: { field: 'Amount', rows: 1 },
      step: {
        key: 'nested-invalid-text',
        kind: 'write-update',
        table: 'Records',
        field: 'Amount',
        rows: 1,
        batchSize: 1,
        typecast: false,
        value: { kind: 'literal', value: 'not-a-number' },
      },
    }),
    expectedError(scenario, {
      key: 'transition-2-reject-out-of-range',
      description: `${scenario.workload.mutationSequence[1]!}：拒绝无效评分值（严格写入）`,
      expectedCode: 'validation.field.invalid_value',
      unchanged: { field: 'Rating', rows: 1 },
      step: {
        key: 'nested-out-of-range',
        kind: 'write-update',
        table: 'Records',
        field: 'Rating',
        rows: 1,
        batchSize: 1,
        typecast: false,
        value: { kind: 'literal', value: 6 },
      },
    }),
    valuesCheck(
      scenario,
      'transition-3-amount',
      `${scenario.workload.mutationSequence[2]!}：数字原值未改变`,
      'Amount',
      allSevens
    ),
  ]);
}

function writeBatchBoundaryTemplate(scenario: Scenario): GeneratorTemplate {
  const boundary = scenario.workload.batchSize;
  const sizes = [boundary - 1, boundary, boundary + 1];
  let expectedRows = scenario.size.rows;
  const workload: BenchWorkloadStep[] = [
    rowCountCheck(scenario, 'transition-1', scenario.workload.mutationSequence[0]!, expectedRows),
  ];
  for (const [index, size] of sizes.entries()) {
    const suffix = ['minus-one', 'equal', 'plus-one'][index]!;
    workload.push({
      key: `transition-2-write-${suffix}`,
      kind: 'write-create',
      table: 'Records',
      rows: size,
      batchSize: size,
      typecast: false,
    });
    expectedRows += size;
    workload.push(
      rowCountCheck(
        scenario,
        `transition-2-${suffix}`,
        `${scenario.workload.mutationSequence[1]!}：${size} 条`,
        expectedRows
      )
    );
  }
  workload.push(
    rowCountCheck(scenario, 'transition-3', scenario.workload.mutationSequence[2]!, expectedRows)
  );
  return template(scenario, workload, { expectedRows });
}

function apiBatchLimitTemplate(scenario: Scenario): GeneratorTemplate {
  const limit = CATALOGUE_API_BATCH_LIMIT;
  let expectedRows = scenario.size.rows;
  const workload: BenchWorkloadStep[] = [];
  for (const [index, size] of [limit - 1, limit].entries()) {
    const transition = index + 1;
    workload.push({
      key: `transition-${transition}-create-${size}`,
      kind: 'write-create',
      table: 'Records',
      rows: size,
      batchSize: size,
      typecast: false,
    });
    expectedRows += size;
    workload.push(
      rowCountCheck(
        scenario,
        `transition-${transition}`,
        `${scenario.workload.mutationSequence[index]!}：运行时上限 ${limit}，提交 ${size}`,
        expectedRows
      )
    );
  }
  workload.push(
    expectedError(scenario, {
      key: 'transition-3-reject-limit-plus-one',
      description: `${scenario.workload.mutationSequence[2]!}：运行时上限 ${limit}，提交 ${limit + 1}`,
      expectedCode: 'validation.limit.records_per_mutation_max',
      unchanged: { field: 'Amount', rows: 1 },
      step: {
        key: 'nested-limit-plus-one',
        kind: 'write-create',
        table: 'Records',
        rows: limit + 1,
        batchSize: limit + 1,
        typecast: false,
      },
    }),
    rowCountCheck(
      scenario,
      'transition-3-atomic',
      `${scenario.workload.mutationSequence[2]!}：拒绝后行数不变`,
      expectedRows
    )
  );
  return template(scenario, workload, { expectedRows });
}

function apiPageLimitTemplate(scenario: Scenario): GeneratorTemplate {
  const limit = CATALOGUE_API_PAGE_LIMIT;
  const under = 'transition-1-page-limit-minus-one';
  const equal = 'transition-1-page-limit';
  return template(scenario, [
    {
      key: under,
      kind: 'query-core',
      table: 'Records',
      query: { limit: limit - 1, includeTotal: true },
    },
    queryCheck(
      scenario,
      'transition-1-minus-one',
      `${scenario.workload.mutationSequence[0]!}：页大小 ${limit - 1}`,
      under,
      Math.min(scenario.size.rows, limit - 1),
      scenario.size.rows <= limit - 1
    ),
    {
      key: equal,
      kind: 'query-core',
      table: 'Records',
      query: { limit, includeTotal: true },
    },
    queryCheck(
      scenario,
      'transition-1-equal',
      `${scenario.workload.mutationSequence[0]!}：页大小 ${limit}`,
      equal,
      Math.min(scenario.size.rows, limit),
      scenario.size.rows <= limit
    ),
    expectedError(scenario, {
      key: 'transition-2-reject-page-limit-plus-one',
      description: `${scenario.workload.mutationSequence[1]!}：页大小 ${limit + 1}`,
      expectedCode: 'validation.invalid',
      step: {
        key: 'nested-page-limit-plus-one',
        kind: 'query-core',
        table: 'Records',
        query: { limit: limit + 1, includeTotal: true },
      },
    }),
  ]);
}

/** Materializers for query semantics, write boundaries, and finite API limits. */
export function queryWriteTemplateForScenario(scenario: Scenario): GeneratorTemplate | undefined {
  switch (scenario.ruleId) {
    case 'R-QUERY-003':
      return stableSortTemplate(scenario);
    case 'R-QUERY-005':
      return structuredQueryTemplate(scenario);
    case 'R-WRITE-005':
      return invalidTypecastTemplate(scenario);
    case 'R-WRITE-006':
      return writeBatchBoundaryTemplate(scenario);
    case 'R-LIMIT-001':
      return apiBatchLimitTemplate(scenario);
    case 'R-LIMIT-002':
      return apiPageLimitTemplate(scenario);
    default:
      return undefined;
  }
}
