import { sha256Hex } from '../case/canonicalJson';
import type {
  BenchCheckpointCheck,
  BenchDatasetRecipe,
  BenchOracle,
  BenchWorkloadStep,
} from '../case/manifest';
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
    };

type TemplateParts = Pick<
  GeneratorTemplate,
  'rootTable' | 'structure' | 'dataset' | 'workload' | 'oracle'
>;

type TemplateStructure = { tables: Array<{ id: string; fields: unknown[] }> };

function isTemplateStructure(value: unknown): value is TemplateStructure {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('tables' in value) ||
    !Array.isArray(value.tables)
  )
    return false;
  return value.tables.every(
    (table) =>
      typeof table === 'object' &&
      table !== null &&
      'id' in table &&
      typeof table.id === 'string' &&
      'fields' in table &&
      Array.isArray(table.fields)
  );
}

export const CATALOGUE_SAMPLES = 3;

// Reuse stays opt-in: these recipe-seeded cases keep deterministic rows and stable mappings.
// Dynamic record creation or deletion must never be added without a stable identity proof.
const IDENTICAL_STATE_CHECKPOINT_RULE_IDS: Readonly<Record<string, true>> = {
  ['R-LINK-001']: true,
  ['R-LINK-002']: true,
  ['R-LINK-003']: true,
  ['R-ROLLUP-001']: true,
  ['R-ROLLUP-002']: true,
  ['R-COND-001']: true,
  ['R-COND-002']: true,
};

const IDENTICAL_STATE_FINAL_ORACLE_RULE_IDS: Readonly<Record<string, true>> = {
  ...IDENTICAL_STATE_CHECKPOINT_RULE_IDS,
  ['R-FORMULA-001']: true,
  ['R-FORMULA-002']: true,
  ['R-FORMULA-003']: true,
  ['R-FORMULA-006']: true,
};

const grid = [{ type: 'grid', name: 'Grid' }];

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

const basicStructure = {
  tables: [
    {
      id: 'tblcatalogRecord0000',
      name: 'Records',
      fields: [
        { id: 'fldcatalogTitle0000', name: 'Title', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogAmount000', name: 'Amount', type: 'number' },
        { id: 'fldcatalogNoise0000', name: 'Noise', type: 'number' },
        {
          id: 'fldcatalogDouble000',
          name: 'Doubled',
          type: 'formula',
          cellValueType: 'number',
          options: { expression: 'IF({fldcatalogAmount000},{fldcatalogAmount000}*2,0)' },
        },
      ],
      views: grid,
    },
  ],
};

const nullFormulaStructure = {
  tables: [
    {
      id: 'tblcatalogNullFormula',
      name: 'Records',
      fields: [
        { id: 'fldcatalogNullTitle', name: 'Title', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogNullSource', name: 'Amount', type: 'number' },
        {
          id: 'fldcatalogNullResult',
          name: 'NullableDouble',
          type: 'formula',
          cellValueType: 'number',
          options: {
            expression: 'IF({fldcatalogNullSource}=BLANK(),BLANK(),{fldcatalogNullSource}*2)',
          },
        },
      ],
      views: grid,
    },
  ],
};

const errorFormulaStructure = {
  tables: [
    {
      id: 'tblcatalogErrorForm',
      name: 'Records',
      fields: [
        { id: 'fldcatalogErrorTitle', name: 'Title', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogDenominator', name: 'Denominator', type: 'number' },
        {
          id: 'fldcatalogErrorValue',
          name: 'DivisionStatus',
          type: 'formula',
          cellValueType: 'string',
          options: {
            expression:
              'IF(IS_ERROR(12/{fldcatalogDenominator}),ERROR("division by zero"),"quotient available")',
          },
        },
      ],
      views: grid,
    },
  ],
};

const typeBoundaryFormulaStructure = {
  tables: [
    {
      id: 'tblcatalogTypeBound',
      name: 'Records',
      fields: [
        { id: 'fldcatalogTypeTitle', name: 'Title', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogNumberSrc', name: 'NumberSource', type: 'number' },
        { id: 'fldcatalogTextSource', name: 'TextSource', type: 'singleLineText' },
        {
          id: 'fldcatalogDateSource',
          name: 'DateSource',
          type: 'date',
          options: { formatting: { date: 'YYYY-MM-DD', time: 'HH:mm', timeZone: 'utc' } },
        },
        { id: 'fldcatalogBoolSource', name: 'BooleanSource', type: 'checkbox' },
        {
          id: 'fldcatalogSelectSrc',
          name: 'SelectSource',
          type: 'singleSelect',
          options: {
            choices: [
              { id: 'optBoundaryFirst', name: 'First', color: 'blue' },
              { id: 'optBoundaryLast', name: 'Last', color: 'green' },
            ],
          },
        },
        {
          id: 'fldcatalogNumberOut',
          name: 'NumberFormula',
          type: 'formula',
          cellValueType: 'number',
          options: {
            expression: 'IF({fldcatalogNumberSrc}=BLANK(),BLANK(),{fldcatalogNumberSrc}*2)',
          },
        },
        {
          id: 'fldcatalogTextOutput',
          name: 'TextFormula',
          type: 'formula',
          cellValueType: 'string',
          options: {
            expression:
              'IF({fldcatalogTextSource}=BLANK(),BLANK(),UPPER(TRIM({fldcatalogTextSource})))',
          },
        },
        {
          id: 'fldcatalogDateOutput',
          name: 'DateFormula',
          type: 'formula',
          cellValueType: 'string',
          options: {
            expression:
              'IF({fldcatalogDateSource}=BLANK(),BLANK(),DATETIME_FORMAT(DATE_ADD({fldcatalogDateSource},1,"day"),"YYYY-MM-DD"))',
            timeZone: 'UTC',
          },
        },
        {
          id: 'fldcatalogBoolOutput',
          name: 'BooleanFormula',
          type: 'formula',
          cellValueType: 'string',
          options: { expression: 'IF({fldcatalogBoolSource},"checked","unchecked")' },
        },
        {
          id: 'fldcatalogSelectOut',
          name: 'SelectFormula',
          type: 'formula',
          cellValueType: 'string',
          options: {
            expression:
              'IF({fldcatalogSelectSrc}=BLANK(),BLANK(),IF({fldcatalogSelectSrc}="Last","terminal","initial"))',
          },
        },
      ],
      views: grid,
    },
  ],
};

function basicDataset(scenario: Scenario, amount = 7): BenchDatasetRecipe {
  return {
    tables: {
      Records: {
        fields: {
          ...profileRecipe(scenario),
          Amount: { distribution: 'constant', min: amount, max: amount },
        },
      },
    },
  };
}

const lookupStructure = {
  tables: [
    {
      id: 'tblcatalogParent0000',
      name: 'Parents',
      fields: [
        { id: 'fldcatalogPName0000', name: 'Name', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogPAmount000', name: 'Amount', type: 'number' },
      ],
      views: grid,
    },
    {
      id: 'tblcatalogChild00000',
      name: 'Children',
      fields: [
        { id: 'fldcatalogCTitle000', name: 'Title', type: 'singleLineText', isPrimary: true },
        {
          id: 'fldcatalogParent000',
          name: 'Parent',
          type: 'link',
          options: {
            relationship: 'manyOne',
            foreignTableId: 'tblcatalogParent0000',
            lookupFieldId: 'fldcatalogPName0000',
            isOneWay: true,
          },
        },
        {
          id: 'fldcatalogLookup000',
          name: 'ParentValue',
          type: 'lookup',
          lookupOptions: {
            linkFieldId: 'fldcatalogParent000',
            foreignTableId: 'tblcatalogParent0000',
            lookupFieldId: 'fldcatalogPAmount000',
          },
        },
        {
          id: 'fldcatalogParentSum0',
          name: 'ParentTotal',
          type: 'formula',
          cellValueType: 'number',
          options: { expression: 'SUM({fldcatalogLookup000})' },
        },
      ],
      views: grid,
    },
  ],
};

const membershipStructure = {
  tables: [
    {
      id: 'tblcatalogTarget0000',
      name: 'Targets',
      fields: [
        { id: 'fldcatalogTName0000', name: 'Name', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogTAmount000', name: 'Amount', type: 'number' },
      ],
      views: grid,
    },
    {
      id: 'tblcatalogHost000000',
      name: 'Hosts',
      fields: [
        { id: 'fldcatalogHTitle000', name: 'Title', type: 'singleLineText', isPrimary: true },
        {
          id: 'fldcatalogMembers000',
          name: 'Members',
          type: 'link',
          options: {
            relationship: 'manyMany',
            foreignTableId: 'tblcatalogTarget0000',
            lookupFieldId: 'fldcatalogTName0000',
            isOneWay: true,
          },
        },
        {
          id: 'fldcatalogValues0000',
          name: 'MemberValues',
          type: 'lookup',
          lookupOptions: {
            linkFieldId: 'fldcatalogMembers000',
            foreignTableId: 'tblcatalogTarget0000',
            lookupFieldId: 'fldcatalogTAmount000',
          },
        },
        {
          id: 'fldcatalogTotal00000',
          name: 'MemberTotal',
          type: 'rollup',
          cellValueType: 'number',
          options: { expression: 'sum({values})' },
          lookupOptions: {
            linkFieldId: 'fldcatalogMembers000',
            foreignTableId: 'tblcatalogTarget0000',
            lookupFieldId: 'fldcatalogTAmount000',
          },
        },
        {
          id: 'fldcatalogMembersSum',
          name: 'MemberSum',
          type: 'formula',
          cellValueType: 'number',
          options: {
            expression: 'IF(COUNTA({fldcatalogValues0000})>0,SUM({fldcatalogValues0000}),0)',
          },
        },
      ],
      views: grid,
    },
  ],
};

const conditionalStructure = {
  tables: [
    {
      id: 'tblcatalogCand000000',
      name: 'Candidates',
      fields: [
        { id: 'fldcatalogCName0000', name: 'Name', type: 'singleLineText', isPrimary: true },
        { id: 'fldcatalogCAmount000', name: 'Amount', type: 'number' },
        { id: 'fldcatalogEligible00', name: 'Eligible', type: 'number' },
      ],
      views: grid,
    },
    {
      id: 'tblcatalogResult0000',
      name: 'Results',
      fields: [
        { id: 'fldcatalogRTitle000', name: 'Title', type: 'singleLineText', isPrimary: true },
        {
          id: 'fldcatalogEligVal000',
          name: 'EligibleValues',
          type: 'conditionalLookup',
          lookupOptions: {
            foreignTableId: 'tblcatalogCand000000',
            lookupFieldId: 'fldcatalogCAmount000',
            filter: {
              conjunction: 'and',
              filterSet: [{ fieldId: 'fldcatalogEligible00', operator: 'isGreater', value: 50 }],
            },
          },
        },
        {
          id: 'fldcatalogEligibleSum',
          name: 'EligibleTotal',
          type: 'formula',
          cellValueType: 'number',
          options: {
            expression: 'IF(COUNTA({fldcatalogEligVal000})>0,SUM({fldcatalogEligVal000}),0)',
          },
        },
      ],
      views: grid,
    },
  ],
};

function checkpoint(
  scenario: Scenario,
  index: number,
  description: string,
  check: CheckBody
): BenchWorkloadStep {
  return {
    key: `transition-${index}-checkpoint`,
    kind: 'checkpoint',
    check: {
      ...check,
      checkId: `${scenario.scenarioId}/transition-${index}`,
      description,
      obligationIds: [...scenario.coverageObligationKeys],
    } as BenchCheckpointCheck,
  };
}

function queryCheckpoint(
  scenario: Scenario,
  index: number,
  operations: ReadonlyArray<string>,
  expectedTotal: number,
  suffix?: string
): BenchWorkloadStep {
  const description = suffix
    ? `${scenario.workload.mutationSequence[index - 1]!}：${suffix}`
    : scenario.workload.mutationSequence[index - 1]!;
  const result = checkpoint(scenario, index, description, {
    kind: 'query-record-ids',
    operations,
    expectedTotal,
  });
  if (!suffix || result.kind !== 'checkpoint') return result;
  return {
    ...result,
    key: `${result.key}-${suffix}`,
    check: { ...result.check, checkId: `${result.check.checkId}/${suffix}` },
  };
}

function recomputeCheckpoint(
  scenario: Scenario,
  index: number,
  tables: ReadonlyArray<string>,
  suffix?: string
): BenchWorkloadStep {
  const description = suffix
    ? `${scenario.workload.mutationSequence[index - 1]!}：${suffix}`
    : scenario.workload.mutationSequence[index - 1]!;
  const result = checkpoint(scenario, index, description, {
    kind: 'full-recompute',
    tables,
    maxRows: Math.max(1, scenario.size.rows * 2),
  });
  if (!suffix || result.kind !== 'checkpoint') return result;
  return {
    ...result,
    key: `${result.key}-${suffix}`,
    check: { ...result.check, checkId: `${result.check.checkId}/${suffix}` },
  };
}

function exactValuesCheckpoint(
  scenario: Scenario,
  index: number,
  field: string,
  value: unknown,
  suffix?: string
): BenchWorkloadStep {
  const description = suffix
    ? `${scenario.workload.mutationSequence[index - 1]!}：${suffix}`
    : scenario.workload.mutationSequence[index - 1]!;
  const result = checkpoint(scenario, index, description, {
    kind: 'field-values',
    table: 'Records',
    field,
    expected: Array.from({ length: scenario.size.rows }, () => value),
  });
  if (!suffix || result.kind !== 'checkpoint') return result;
  return {
    ...result,
    key: `${result.key}-${suffix}`,
    check: { ...result.check, checkId: `${result.check.checkId}/${suffix}` },
  };
}

function rowCountCheckpoint(
  scenario: Scenario,
  index: number,
  expected: number,
  suffix?: string
): BenchWorkloadStep {
  const description = suffix
    ? `${scenario.workload.mutationSequence[index - 1]!}：${suffix}`
    : scenario.workload.mutationSequence[index - 1]!;
  const result = checkpoint(scenario, index, description, {
    kind: 'row-count',
    table: 'Records',
    expected,
  });
  if (!suffix || result.kind !== 'checkpoint') return result;
  return {
    ...result,
    key: `${result.key}-${suffix}`,
    check: { ...result.check, checkId: `${result.check.checkId}/${suffix}` },
  };
}

function finalOracle(
  scenario: Scenario,
  tables: ReadonlyArray<string>
): ReadonlyArray<BenchOracle> {
  return [
    {
      key: 'catalogue-final-oracle',
      kind: 'full-recompute',
      tables,
      maxRows: Math.max(1, scenario.size.rows * 2),
      checkId: `${scenario.scenarioId}/final`,
      description: scenario.oracle.expected,
      obligationIds: [...scenario.coverageObligationKeys],
    },
  ];
}

function basic(parts: {
  scenario: Scenario;
  workload: ReadonlyArray<BenchWorkloadStep>;
  amount?: number;
  dataset?: BenchDatasetRecipe;
}): TemplateParts {
  return {
    rootTable: 'Records',
    structure: basicStructure,
    dataset: parts.dataset ?? basicDataset(parts.scenario, parts.amount),
    workload: parts.workload,
    oracle:
      parts.scenario.family === 'formula'
        ? finalOracle(parts.scenario, ['Records'])
        : [
            {
              key: 'catalogue-final-invariant',
              kind: 'invariant',
              checkId: `${parts.scenario.scenarioId}/final`,
              description: parts.scenario.oracle.expected,
              obligationIds: [...parts.scenario.coverageObligationKeys],
              checks: [{ type: 'unique-primary', table: 'Records' }],
            },
          ],
  };
}

function queryTemplate(scenario: Scenario): TemplateParts | undefined {
  const rows = scenario.size.rows;
  if (scenario.ruleId === 'R-QUERY-001') {
    const operation = 'transition-1-read-page';
    return basic({
      scenario,
      workload: [
        {
          key: operation,
          kind: 'query-core',
          table: 'Records',
          query: { limit: rows, includeTotal: true },
        },
        queryCheckpoint(scenario, 1, [operation], rows),
      ],
    });
  }
  if (scenario.ruleId === 'R-QUERY-002') {
    const equality = 'transition-1-filter-equality';
    const range = 'transition-1-filter-range';
    const empty = 'transition-1-filter-null';
    const filterDataset = basicDataset(scenario);
    return basic({
      scenario,
      dataset: {
        tables: {
          Records: {
            fields: {
              ...filterDataset.tables.Records!.fields,
              Noise: { distribution: 'constant', min: 0, max: 0, nullFraction: 1 },
            },
          },
        },
      },
      workload: [
        {
          key: equality,
          kind: 'query-core',
          table: 'Records',
          query: {
            filter: {
              conjunction: 'and',
              filterSet: [{ fieldId: 'Amount', operator: 'is', value: 7 }],
            },
            limit: rows,
            includeTotal: true,
          },
        },
        {
          key: range,
          kind: 'query-core',
          table: 'Records',
          query: {
            filter: {
              conjunction: 'and',
              filterSet: [
                { fieldId: 'Amount', operator: 'isGreaterEqual', value: 6 },
                { fieldId: 'Amount', operator: 'isLessEqual', value: 8 },
              ],
            },
            limit: rows,
            includeTotal: true,
          },
        },
        {
          key: empty,
          kind: 'query-core',
          table: 'Records',
          query: {
            filter: {
              conjunction: 'and',
              filterSet: [{ fieldId: 'Noise', operator: 'isEmpty' }],
            },
            limit: rows,
            includeTotal: true,
          },
        },
        queryCheckpoint(scenario, 2, [equality], rows, '等值条件'),
        queryCheckpoint(scenario, 2, [range], rows, '闭区间条件'),
        queryCheckpoint(scenario, 2, [empty], rows, '空值条件'),
      ],
    });
  }
  if (scenario.ruleId === 'R-QUERY-004') {
    const pageSize = rows === 0 ? 1 : 10;
    const first = 'transition-1-first-page';
    const second = 'transition-2-cursor-page';
    const last = 'transition-3-last-page';
    return basic({
      scenario,
      workload: [
        { key: first, kind: 'query-core', table: 'Records', query: { limit: pageSize } },
        queryCheckpoint(scenario, 1, [first], Math.min(rows, pageSize)),
        {
          key: second,
          kind: 'query-core',
          table: 'Records',
          query:
            rows === 0
              ? { limit: pageSize }
              : { limit: pageSize, cursor: { fromOperation: first } },
        },
        queryCheckpoint(scenario, 2, [first, second], Math.min(rows, pageSize * 2)),
        {
          key: last,
          kind: 'query-core',
          table: 'Records',
          query: { limit: 1, offset: Math.max(0, rows - 1) },
        },
        queryCheckpoint(scenario, 3, [last], Math.min(rows, 1)),
      ],
    });
  }
  return undefined;
}

function writeTemplate(scenario: Scenario): TemplateParts | undefined {
  const rows = scenario.size.rows;
  if (scenario.ruleId === 'R-WRITE-001') {
    const read = 'transition-2-read-created-state';
    return basic({
      scenario,
      workload: [
        {
          key: 'transition-1-create',
          kind: 'write-create',
          table: 'Records',
          rows: 1,
          batchSize: 1,
          typecast: false,
        },
        checkpoint(scenario, 1, scenario.workload.mutationSequence[0]!, {
          kind: 'row-count',
          table: 'Records',
          expected: rows + 1,
        }),
        {
          key: read,
          kind: 'query-core',
          table: 'Records',
          query: { limit: rows + 1 },
        },
        queryCheckpoint(scenario, 2, [read], rows + 1),
      ],
    });
  }
  if (scenario.ruleId === 'R-WRITE-002' || scenario.ruleId === 'R-WRITE-004') {
    const typecast = scenario.ruleId === 'R-WRITE-004';
    const read = 'transition-2-read-new-value';
    return basic({
      scenario,
      workload: [
        {
          key: 'transition-1-update',
          kind: 'write-update',
          table: 'Records',
          field: 'Amount',
          rows: 1,
          batchSize: 1,
          typecast,
          value: { kind: 'literal', value: typecast ? '11' : 11 },
        },
        recomputeCheckpoint(scenario, 1, ['Records']),
        {
          key: read,
          kind: 'query-core',
          table: 'Records',
          query: {
            filter: {
              conjunction: 'and',
              filterSet: [{ fieldId: 'Amount', operator: 'is', value: 11 }],
            },
            limit: rows,
          },
        },
        queryCheckpoint(scenario, 2, [read], 1),
      ],
    });
  }
  if (scenario.ruleId === 'R-WRITE-003') {
    return basic({
      scenario,
      workload: [
        {
          key: 'transition-1-create',
          kind: 'write-create',
          table: 'Records',
          rows: 1,
          batchSize: 1,
          typecast: false,
        },
        rowCountCheckpoint(scenario, 1, rows + 1),
        {
          key: 'transition-2-delete-existing',
          kind: 'write-delete',
          table: 'Records',
          rows,
          batchSize: Math.max(1, Math.min(rows, 1_000)),
          selection: 'first',
        },
        rowCountCheckpoint(scenario, 2, 1, '仅剩末条记录'),
        {
          key: 'transition-2-delete-last-row',
          kind: 'write-delete',
          table: 'Records',
          rows: 1,
          batchSize: 1,
          selection: 'first',
        },
        rowCountCheckpoint(scenario, 2, 0, '删除末条记录后为空表'),
        rowCountCheckpoint(scenario, 3, 0),
      ],
    });
  }
  if (scenario.ruleId === 'R-WRITE-007') {
    return basic({
      scenario,
      workload: [
        {
          key: 'transition-1-initial',
          kind: 'write-update',
          table: 'Records',
          field: 'Amount',
          rows,
          batchSize: rows,
          typecast: false,
          value: { kind: 'literal', value: 7 },
        },
        exactValuesCheckpoint(scenario, 1, 'Amount', 7),
        {
          key: 'transition-2-clear',
          kind: 'write-update',
          table: 'Records',
          field: 'Amount',
          rows,
          batchSize: rows,
          typecast: false,
          value: { kind: 'literal', value: null },
        },
        exactValuesCheckpoint(scenario, 2, 'Amount', null),
        {
          key: 'transition-3-restore',
          kind: 'write-update',
          table: 'Records',
          field: 'Amount',
          rows,
          batchSize: rows,
          typecast: false,
          value: { kind: 'literal', value: 11 },
        },
        exactValuesCheckpoint(scenario, 3, 'Amount', 11),
      ],
    });
  }
  return undefined;
}

function formulaTemplate(scenario: Scenario): TemplateParts | undefined {
  const rows = scenario.size.rows;
  const update = (key: string, field: string, value: unknown): BenchWorkloadStep => ({
    key,
    kind: 'write-update',
    table: 'Records',
    field,
    rows,
    batchSize: rows,
    typecast: false,
    value: { kind: 'literal', value },
  });
  const flush = (key: string): BenchWorkloadStep => ({ key, kind: 'flush-computed' });
  const formulaParts = (
    structure: TemplateParts['structure'],
    dataset: BenchDatasetRecipe,
    workload: ReadonlyArray<BenchWorkloadStep>
  ): TemplateParts => ({
    rootTable: 'Records',
    structure,
    dataset,
    workload,
    oracle: finalOracle(scenario, ['Records']),
  });

  if (scenario.ruleId === 'R-FORMULA-001') {
    return basic({
      scenario,
      workload: [
        update('transition-1-initial-source', 'Amount', 3),
        flush('transition-1-flush'),
        exactValuesCheckpoint(scenario, 1, 'Doubled', 6),
        update('transition-2-update-source', 'Amount', 5),
        flush('transition-2-flush'),
        exactValuesCheckpoint(scenario, 2, 'Doubled', 10),
        flush('transition-3-wait-computed'),
        exactValuesCheckpoint(scenario, 3, 'Doubled', 10),
      ],
    });
  }

  if (scenario.ruleId === 'R-FORMULA-002') {
    return formulaParts(
      nullFormulaStructure,
      {
        tables: {
          Records: {
            fields: {
              ...profileRecipe(scenario),
              Amount: { distribution: 'constant', min: 5, max: 5 },
            },
          },
        },
      },
      [
        update('transition-1-clear-source', 'Amount', null),
        flush('transition-1-flush-null'),
        exactValuesCheckpoint(scenario, 1, 'NullableDouble', null),
        update('transition-2-restore-source', 'Amount', 7),
        flush('transition-2-flush-restored'),
        exactValuesCheckpoint(scenario, 2, 'NullableDouble', 14),
      ]
    );
  }

  if (scenario.ruleId === 'R-FORMULA-003') {
    return formulaParts(
      errorFormulaStructure,
      {
        tables: {
          Records: {
            fields: {
              ...profileRecipe(scenario),
              Denominator: { distribution: 'constant', min: 3, max: 3 },
            },
          },
        },
      },
      [
        update('transition-1-normal-source', 'Denominator', 3),
        flush('transition-1-flush-normal'),
        exactValuesCheckpoint(scenario, 1, 'DivisionStatus', 'quotient available'),
        update('transition-2-trigger-error', 'Denominator', 0),
        flush('transition-2-flush-error'),
        exactValuesCheckpoint(scenario, 2, 'DivisionStatus', '#ERROR: division by zero'),
        update('transition-3-recover-source', 'Denominator', 4),
        flush('transition-3-flush-recovered'),
        exactValuesCheckpoint(scenario, 3, 'DivisionStatus', 'quotient available'),
      ]
    );
  }

  if (scenario.ruleId === 'R-FORMULA-006') {
    const boundaryFields = [
      {
        source: 'NumberSource',
        result: 'NumberFormula',
        first: -12.5,
        firstExpected: -25,
        last: 12.5,
        lastExpected: 25,
        nullExpected: null,
      },
      {
        source: 'TextSource',
        result: 'TextFormula',
        first: '  alpha  ',
        firstExpected: 'ALPHA',
        last: '  omega  ',
        lastExpected: 'OMEGA',
        nullExpected: null,
      },
      {
        source: 'DateSource',
        result: 'DateFormula',
        first: '1970-01-01T00:00:00.000Z',
        firstExpected: '1970-01-02',
        last: '2099-12-31T00:00:00.000Z',
        lastExpected: '2100-01-01',
        nullExpected: null,
      },
      {
        source: 'BooleanSource',
        result: 'BooleanFormula',
        first: false,
        firstExpected: 'unchecked',
        last: true,
        lastExpected: 'checked',
        nullExpected: 'unchecked',
      },
      {
        source: 'SelectSource',
        result: 'SelectFormula',
        first: 'First',
        firstExpected: 'initial',
        last: 'Last',
        lastExpected: 'terminal',
        nullExpected: null,
      },
    ] as const;
    const phase = (
      name: 'first' | 'last' | 'null',
      value: 'first' | 'last' | undefined,
      expected: 'firstExpected' | 'lastExpected' | 'nullExpected'
    ): ReadonlyArray<BenchWorkloadStep> => [
      ...boundaryFields.map((field) =>
        update(
          `transition-1-${name}-${field.source}`,
          field.source,
          value === undefined ? null : field[value]
        )
      ),
      flush(`transition-1-flush-${name}`),
      ...boundaryFields.map((field) =>
        exactValuesCheckpoint(scenario, 1, field.result, field[expected], `${name}-${field.source}`)
      ),
    ];
    return formulaParts(
      typeBoundaryFormulaStructure,
      {
        tables: {
          Records: {
            fields: {
              ...profileRecipe(scenario),
              NumberSource: { distribution: 'constant', min: 1, max: 1 },
              TextSource: { width: scenario.profile.textWidth },
              DateSource: {},
              BooleanSource: {},
              SelectSource: { choices: ['First', 'Last'] },
            },
          },
        },
      },
      [
        ...phase('first', 'first', 'firstExpected'),
        ...phase('last', 'last', 'lastExpected'),
        ...phase('null', undefined, 'nullExpected'),
      ]
    );
  }
  return undefined;
}

function relationshipDataset(scenario: Scenario): BenchDatasetRecipe {
  return {
    tables: {
      Targets: { fields: { Amount: { distribution: 'constant', min: 7, max: 7 } } },
      Hosts: {
        fields: {
          ...profileRecipe(scenario),
          // Membership is established explicitly so updates always affect the declared targets.
        },
      },
    },
  };
}

function membershipTemplate(scenario: Scenario): TemplateParts | undefined {
  const rows = scenario.size.rows;
  const members = (key: string, indices: ReadonlyArray<number>): BenchWorkloadStep => ({
    key,
    kind: 'write-update',
    table: 'Hosts',
    field: 'Members',
    rows,
    batchSize: rows,
    typecast: false,
    value: { kind: 'link-targets', table: 'Targets', indices },
  });
  if (scenario.ruleId === 'R-LINK-002' || scenario.ruleId === 'R-ROLLUP-001') {
    return {
      rootTable: 'Hosts',
      structure: membershipStructure,
      dataset: relationshipDataset(scenario),
      workload: [
        recomputeCheckpoint(scenario, 1, ['Hosts']),
        members('transition-2-add-first', [0]),
        recomputeCheckpoint(scenario, 2, ['Hosts']),
        members('transition-3-add-many', [0, 1, 2]),
        recomputeCheckpoint(scenario, 3, ['Hosts']),
        members('transition-4-remove-one', [0, 1]),
        recomputeCheckpoint(scenario, 4, ['Hosts'], '移除一个后的中间状态'),
        members('transition-4-remove-next', [0]),
        recomputeCheckpoint(scenario, 4, ['Hosts'], '移除倒数第二个后的状态'),
        members('transition-4-remove-last', []),
        recomputeCheckpoint(scenario, 4, ['Hosts'], '移除最后一个后的精确空集合'),
      ],
      oracle: finalOracle(scenario, ['Hosts']),
    };
  }
  if (scenario.ruleId === 'R-LINK-003') {
    return {
      rootTable: 'Hosts',
      structure: membershipStructure,
      dataset: relationshipDataset(scenario),
      workload: [
        members('transition-1-establish-many', [0, 1, 2]),
        recomputeCheckpoint(scenario, 1, ['Hosts']),
        members('transition-2-clear-all', []),
        recomputeCheckpoint(scenario, 2, ['Hosts']),
      ],
      oracle: finalOracle(scenario, ['Hosts']),
    };
  }
  if (scenario.ruleId === 'R-ROLLUP-002') {
    const updateTarget = (key: string, value: unknown): BenchWorkloadStep => ({
      key,
      kind: 'write-update',
      table: 'Targets',
      field: 'Amount',
      rows: 1,
      batchSize: 1,
      typecast: false,
      value: { kind: 'literal', value },
    });
    return {
      rootTable: 'Hosts',
      structure: membershipStructure,
      dataset: relationshipDataset(scenario),
      workload: [
        members('transition-1-establish-many', [0, 1, 2]),
        recomputeCheckpoint(scenario, 1, ['Hosts']),
        updateTarget('transition-2-update-child', 11),
        { key: 'transition-2-flush', kind: 'flush-computed' },
        recomputeCheckpoint(scenario, 2, ['Hosts']),
        updateTarget('transition-3-clear-child', null),
        { key: 'transition-3-flush', kind: 'flush-computed' },
        recomputeCheckpoint(scenario, 3, ['Hosts']),
        updateTarget('transition-4-restore-child', 13),
        { key: 'transition-4-flush', kind: 'flush-computed' },
        recomputeCheckpoint(scenario, 4, ['Hosts']),
      ],
      oracle: finalOracle(scenario, ['Hosts']),
    };
  }
  return undefined;
}

function lookupTemplate(scenario: Scenario): TemplateParts | undefined {
  if (scenario.ruleId !== 'R-LINK-001') return undefined;
  return {
    rootTable: 'Children',
    structure: lookupStructure,
    dataset: {
      tables: {
        Parents: { fields: { Amount: { distribution: 'constant', min: 7, max: 7 } } },
        Children: {
          fields: {
            ...profileRecipe(scenario),
            Parent: { link: { table: 'Parents', relationship: 'manyOne' } },
          },
        },
      },
    },
    workload: [
      recomputeCheckpoint(scenario, 1, ['Children']),
      {
        key: 'transition-2-update-parent',
        kind: 'write-update',
        table: 'Parents',
        field: 'Amount',
        rows: Math.max(3, Math.round(scenario.size.rows / 10)),
        batchSize: 1,
        typecast: false,
        value: { kind: 'literal', value: 11 },
      },
      { key: 'transition-2-flush', kind: 'flush-computed' },
      recomputeCheckpoint(scenario, 2, ['Children']),
      recomputeCheckpoint(scenario, 3, ['Children']),
    ],
    oracle: finalOracle(scenario, ['Children']),
  };
}

function conditionalTemplate(scenario: Scenario): TemplateParts | undefined {
  if (scenario.ruleId !== 'R-COND-001' && scenario.ruleId !== 'R-COND-002') return undefined;
  const rows = Math.max(3, Math.round(scenario.size.rows / 10));
  const update = (key: string, value: number, updateRows = rows): BenchWorkloadStep => ({
    key,
    kind: 'write-update',
    table: 'Candidates',
    field: 'Eligible',
    rows: updateRows,
    batchSize: updateRows,
    typecast: false,
    value: { kind: 'literal', value },
  });
  const dataset: BenchDatasetRecipe = {
    tables: {
      Candidates: {
        fields: {
          Amount: { distribution: 'constant', min: 7, max: 7 },
          Eligible: {
            distribution: 'constant',
            min: scenario.ruleId === 'R-COND-002' ? 100 : 0,
            max: scenario.ruleId === 'R-COND-002' ? 100 : 0,
          },
        },
      },
      Results: { fields: profileRecipe(scenario) },
    },
  };
  const workload: BenchWorkloadStep[] =
    scenario.ruleId === 'R-COND-001'
      ? [
          update('transition-1-exclude', 0),
          { key: 'transition-1-flush', kind: 'flush-computed' },
          recomputeCheckpoint(scenario, 1, ['Results']),
          update('transition-2-include', 100),
          { key: 'transition-2-flush', kind: 'flush-computed' },
          recomputeCheckpoint(scenario, 2, ['Results']),
          update('transition-3-exclude-again', 0),
          { key: 'transition-3-flush', kind: 'flush-computed' },
          recomputeCheckpoint(scenario, 3, ['Results']),
        ]
      : [
          recomputeCheckpoint(scenario, 1, ['Results']),
          update('transition-2-empty', 0),
          { key: 'transition-2-flush', kind: 'flush-computed' },
          recomputeCheckpoint(scenario, 2, ['Results']),
          update('transition-3-one-match', 100, 1),
          { key: 'transition-3-flush', kind: 'flush-computed' },
          recomputeCheckpoint(scenario, 3, ['Results']),
        ];
  return {
    rootTable: 'Results',
    structure: conditionalStructure,
    dataset,
    workload,
    oracle: finalOracle(scenario, ['Results']),
  };
}

function transformCatalogueWorkload(scenario: Scenario, parts: TemplateParts): BenchWorkloadStep[] {
  let memberSum = 0;
  let parentSum = 7;
  let eligibleCount =
    scenario.ruleId === 'R-COND-002' ? Math.max(3, Math.round(scenario.size.rows / 10)) : 0;
  return parts.workload.flatMap((step): BenchWorkloadStep[] => {
    if (step.kind === 'write-update') {
      if (step.value.kind === 'link-targets') memberSum = step.value.indices.length * 7;
      if (step.table === 'Targets' && step.value.kind === 'literal') {
        const changed = typeof step.value.value === 'number' ? step.value.value : 0;
        memberSum = 7 * Math.max(0, 3 - step.rows) + changed;
      }
      if (step.table === 'Parents' && step.value.kind === 'literal')
        parentSum = Number(step.value.value);
      if (step.table === 'Candidates' && step.value.kind === 'literal') {
        const candidates = Math.max(3, Math.round(scenario.size.rows / 10));
        eligibleCount =
          Number(step.value.value) > 50 ? (step.rows >= candidates ? candidates : step.rows) : 0;
      }
    }
    if (step.kind !== 'checkpoint' || step.check.kind !== 'full-recompute') return [step];
    const state =
      parts.rootTable === 'Hosts'
        ? { field: 'MemberSum', value: memberSum }
        : parts.rootTable === 'Children'
          ? { field: 'ParentTotal', value: parentSum }
          : parts.rootTable === 'Results'
            ? { field: 'EligibleTotal', value: eligibleCount * 7 }
            : undefined;
    const flush: BenchWorkloadStep = { key: `${step.key}-flush`, kind: 'flush-computed' };
    if (!state) return [flush, step];
    return [
      flush,
      {
        key: `${step.key}-exact`,
        kind: 'checkpoint',
        check: {
          description: step.check.description,
          obligationIds: step.check.obligationIds,
          kind: 'field-values',
          table: parts.rootTable,
          field: state.field,
          expected: Array.from({ length: scenario.size.rows }, () => state.value),
          checkId: `${step.check.checkId}/exact`,
        },
      },
      step,
    ];
  });
}

export function catalogueTemplateForScenario(scenario: Scenario): GeneratorTemplate | undefined {
  const parts =
    queryTemplate(scenario) ??
    writeTemplate(scenario) ??
    formulaTemplate(scenario) ??
    lookupTemplate(scenario) ??
    membershipTemplate(scenario) ??
    conditionalTemplate(scenario);
  if (!parts) return undefined;
  if (!isTemplateStructure(parts.structure))
    throw new Error('Catalogue template structure is invalid');
  const structure = parts.structure;
  const withNoise = {
    ...structure,
    tables: structure.tables.map((table) => ({
      ...table,
      fields: table.fields.some(
        (field) =>
          typeof field === 'object' && field !== null && 'name' in field && field.name === 'Noise'
      )
        ? table.fields
        : [...table.fields, { id: `fld${table.id.slice(3)}n`, name: 'Noise', type: 'number' }],
    })),
  };
  const reuseCheckpoint = Object.prototype.hasOwnProperty.call(
    IDENTICAL_STATE_CHECKPOINT_RULE_IDS,
    scenario.ruleId
  );
  const workload = transformCatalogueWorkload(scenario, parts).map((step) =>
    reuseCheckpoint && step.kind === 'checkpoint' && step.check.kind === 'full-recompute'
      ? { ...step, check: { ...step.check, reuse: 'identical-state' as const } }
      : step
  );
  const reuseFinalOracle = Object.prototype.hasOwnProperty.call(
    IDENTICAL_STATE_FINAL_ORACLE_RULE_IDS,
    scenario.ruleId
  );
  const oracle = parts.oracle.map((entry) =>
    reuseFinalOracle && entry.kind === 'full-recompute'
      ? { ...entry, reuse: 'identical-state' as const }
      : entry
  );
  return {
    id: scenario.fixture.reference,
    ...parts,
    structure: normalizeStructureIds(withNoise),
    workload,
    oracle,
  };
}

/** Internal semantic IDs are rewritten together, including expressions and relationship options. */
function normalizeStructureIds(structure: {
  tables: ReadonlyArray<{ id: string; fields: ReadonlyArray<unknown> }>;
}): unknown {
  const ids = new Map<string, string>();
  for (const table of structure.tables) {
    ids.set(table.id, `tbl${sha256Hex(table.id).slice(0, 16)}`);
    for (const field of table.fields) {
      if (
        typeof field !== 'object' ||
        field === null ||
        !('id' in field) ||
        typeof field.id !== 'string'
      ) {
        throw new Error('Catalogue template field requires an ID');
      }
      ids.set(field.id, `fld${sha256Hex(field.id).slice(0, 16)}`);
    }
  }
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      return (
        ids.get(value) ??
        value.replace(/\{(fld[A-Za-z0-9]+)\}/g, (match, id: string) => {
          const replacement = ids.get(id);
          if (!replacement) throw new Error(`Unknown formula field ${id}`);
          return `{${replacement}}`;
        })
      );
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    }
    return value;
  };
  return rewrite(structure);
}
