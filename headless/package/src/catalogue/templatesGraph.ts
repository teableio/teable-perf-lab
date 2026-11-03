import { sha256Hex } from '../case/canonicalJson';
import type {
  BenchDatasetRecipe,
  BenchOracle,
  BenchWorkloadStep,
  FullRecomputeReuse,
} from '../case/manifest';
import type { GeneratorTemplate } from '../generator/generate';
import type { Scenario } from './schema';

const grid = [{ type: 'grid', name: 'Grid' }];
const GRAPH_RULE_IDS: Readonly<Record<string, true>> = {
  ['R-FORMULA-004']: true,
  ['R-FORMULA-005']: true,
  ['R-PROP-001']: true,
  ['R-PROP-002']: true,
  ['R-PROP-003']: true,
  ['R-PROP-004']: true,
};

type Structure = {
  readonly tables: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly fields: ReadonlyArray<Record<string, unknown>>;
    readonly views: ReadonlyArray<{ readonly type: string; readonly name: string }>;
  }>;
};

type TemplateParts = Omit<GeneratorTemplate, 'id'>;

type CheckBody =
  | {
      readonly kind: 'field-values';
      readonly table: string;
      readonly field: string;
      readonly expected: unknown;
    }
  | {
      readonly kind: 'full-recompute';
      readonly tables: ReadonlyArray<string>;
      readonly maxRows: number;
      readonly reuse?: FullRecomputeReuse;
    }
  | {
      readonly kind: 'query-values';
      readonly operations: ReadonlyArray<string>;
      readonly expected: unknown;
      readonly ordered: boolean;
    };

function stableId(prefix: 'tbl' | 'fld', semanticName: string): string {
  return `${prefix}${sha256Hex(`catalogue-graph:${semanticName}`).slice(0, 16)}`;
}

function tableId(name: string): string {
  return stableId('tbl', name);
}

function fieldId(table: string, field: string): string {
  return stableId('fld', `${table}.${field}`);
}

function primaryField(table: string): Record<string, unknown> {
  return {
    id: fieldId(table, 'Title'),
    name: 'Title',
    type: 'singleLineText',
    isPrimary: true,
  };
}

function numberField(table: string, name: string): Record<string, unknown> {
  return { id: fieldId(table, name), name, type: 'number' };
}

function formulaField(table: string, name: string, expression: string): Record<string, unknown> {
  return {
    id: fieldId(table, name),
    name,
    type: 'formula',
    cellValueType: 'number',
    options: { expression },
  };
}

function linkField(table: string, name: string, foreignTable: string): Record<string, unknown> {
  return {
    id: fieldId(table, name),
    name,
    type: 'link',
    options: {
      relationship: 'manyOne',
      foreignTableId: tableId(foreignTable),
      lookupFieldId: fieldId(foreignTable, 'Title'),
      isOneWay: true,
    },
  };
}

function lookupField(
  table: string,
  name: string,
  link: string,
  foreignTable: string,
  foreignField: string
): Record<string, unknown> {
  return {
    id: fieldId(table, name),
    name,
    type: 'lookup',
    lookupOptions: {
      linkFieldId: fieldId(table, link),
      foreignTableId: tableId(foreignTable),
      lookupFieldId: fieldId(foreignTable, foreignField),
    },
  };
}

function table(
  name: string,
  fields: ReadonlyArray<Record<string, unknown>>
): Structure['tables'][number] {
  return { id: tableId(name), name, fields: [primaryField(name), ...fields], views: grid };
}

function constantDataset(
  tableNames: ReadonlyArray<string>,
  sourceTable: string,
  sourceField = 'Amount',
  sourceValue = 7
): BenchDatasetRecipe {
  return {
    tables: Object.fromEntries(
      tableNames.map((name) => [
        name,
        {
          fields: {
            Title: { width: 16 },
            ...(name === sourceTable
              ? { [sourceField]: { distribution: 'constant', min: sourceValue, max: sourceValue } }
              : {}),
          },
        },
      ])
    ),
  };
}

function update(
  key: string,
  table: string,
  field: string,
  rows: number,
  value: unknown,
  batchSize = rows
): BenchWorkloadStep {
  return {
    key,
    kind: 'write-update',
    table,
    field,
    rows,
    batchSize: Math.max(1, batchSize),
    typecast: false,
    value: { kind: 'literal', value },
  };
}

function link(
  key: string,
  table: string,
  field: string,
  rows: number,
  targetTable: string,
  targetIndex = 0
): BenchWorkloadStep {
  return {
    key,
    kind: 'write-update',
    table,
    field,
    rows,
    batchSize: Math.min(1_000, Math.max(1, rows)),
    typecast: false,
    value: { kind: 'link-targets', table: targetTable, indices: [targetIndex] },
  };
}

function checkpoint(
  scenario: Scenario,
  transition: number,
  suffix: string,
  description: string,
  check: CheckBody
): BenchWorkloadStep {
  return {
    key: `transition-${transition}-checkpoint-${suffix}`,
    kind: 'checkpoint',
    check: {
      ...check,
      checkId: `${scenario.scenarioId}/transition-${transition}/${suffix}`,
      description,
      obligationIds: [...scenario.coverageObligationKeys],
    },
  };
}

function exactFieldCheckpoint(input: {
  scenario: Scenario;
  transition: number;
  suffix: string;
  table: string;
  field: string;
  value: unknown;
}): BenchWorkloadStep {
  return checkpoint(
    input.scenario,
    input.transition,
    input.suffix,
    `${input.scenario.workload.mutationSequence[input.transition - 1]!}：${input.table}.${input.field}`,
    {
      kind: 'field-values',
      table: input.table,
      field: input.field,
      expected: Array.from({ length: input.scenario.size.rows }, () => input.value),
    }
  );
}

/** Repetition-local references remain checkpoint-key scoped; transitions never share state. */
function recomputeCheckpoint(input: {
  scenario: Scenario;
  transition: number;
  suffix: string;
  tables: ReadonlyArray<string>;
  description: string;
  maxRows: number;
}): BenchWorkloadStep {
  return checkpoint(input.scenario, input.transition, input.suffix, input.description, {
    kind: 'full-recompute',
    tables: input.tables,
    maxRows: input.maxRows,
    reuse: 'identical-state',
  });
}

/** Final references are reused only across identical samples within one repetition. */
function finalOracle(
  scenario: Scenario,
  tables: ReadonlyArray<string>,
  maxRows: number
): ReadonlyArray<BenchOracle> {
  return [
    {
      key: 'catalogue-graph-final-oracle',
      kind: 'full-recompute',
      tables,
      maxRows,
      reuse: 'identical-state',
      checkId: `${scenario.scenarioId}/final`,
      description: scenario.oracle.expected,
      obligationIds: [...scenario.coverageObligationKeys],
    },
  ];
}

function formulaDepthTemplate(scenario: Scenario): TemplateParts {
  const tableName = 'FormulaDepth';
  const sourceId = fieldId(tableName, 'Amount');
  const depth = scenario.size.graphDepth;
  const fields: Array<Record<string, unknown>> = [numberField(tableName, 'Amount')];
  for (let level = 1; level <= depth; level += 1) {
    const previous = level === 1 ? sourceId : fieldId(tableName, `Level${level - 1}`);
    fields.push(formulaField(tableName, `Level${level}`, `IF({${previous}},{${previous}}+1,0)`));
  }
  const workload: BenchWorkloadStep[] = [
    update('transition-1-update-root', tableName, 'Amount', scenario.size.rows, 11, 1_000),
    exactFieldCheckpoint({
      scenario,
      transition: 1,
      suffix: 'root',
      table: tableName,
      field: 'Amount',
      value: 11,
    }),
    { key: 'transition-2-wait-computed', kind: 'flush-computed' },
  ];
  for (let level = 1; level <= depth; level += 1) {
    workload.push(
      exactFieldCheckpoint({
        scenario,
        transition: 2,
        suffix: `level-${String(level).padStart(2, '0')}`,
        table: tableName,
        field: `Level${level}`,
        value: 11 + level,
      })
    );
  }
  return {
    rootTable: tableName,
    structure: { tables: [table(tableName, fields)] },
    dataset: constantDataset([tableName], tableName),
    workload,
    oracle: finalOracle(scenario, [tableName], scenario.size.rows),
  };
}

function formulaWidthTemplate(scenario: Scenario): TemplateParts {
  const tableName = 'FormulaWidth';
  const sourceId = fieldId(tableName, 'Amount');
  const width = scenario.size.graphWidth;
  const fields: Array<Record<string, unknown>> = [numberField(tableName, 'Amount')];
  for (let target = 1; target <= width; target += 1) {
    fields.push(
      formulaField(tableName, `Target${target}`, `IF({${sourceId}},{${sourceId}}*${target},0)`)
    );
  }
  const workload: BenchWorkloadStep[] = [
    update('transition-1-update-shared-source', tableName, 'Amount', scenario.size.rows, 11, 1_000),
    exactFieldCheckpoint({
      scenario,
      transition: 1,
      suffix: 'shared-source',
      table: tableName,
      field: 'Amount',
      value: 11,
    }),
    { key: 'transition-2-wait-computed', kind: 'flush-computed' },
  ];
  for (let target = 1; target <= width; target += 1) {
    workload.push(
      exactFieldCheckpoint({
        scenario,
        transition: 2,
        suffix: `target-${String(target).padStart(3, '0')}`,
        table: tableName,
        field: `Target${target}`,
        value: 11 * target,
      })
    );
  }
  return {
    rootTable: tableName,
    structure: { tables: [table(tableName, fields)] },
    dataset: constantDataset([tableName], tableName),
    workload,
    oracle: finalOracle(scenario, [tableName], scenario.size.rows),
  };
}

function propagationHopFields(
  tableName: string,
  parentTable: string,
  parentValueField: string
): ReadonlyArray<Record<string, unknown>> {
  const lookupName = 'ParentValue';
  return [
    linkField(tableName, 'Parent', parentTable),
    lookupField(tableName, lookupName, 'Parent', parentTable, parentValueField),
    formulaField(
      tableName,
      'Value',
      `IF(COUNTA({${fieldId(tableName, lookupName)}})>0,SUM({${fieldId(tableName, lookupName)}}),0)`
    ),
  ];
}

function multihopTemplate(scenario: Scenario): TemplateParts {
  const source = 'PropagationSource';
  const hops = Array.from(
    { length: scenario.size.graphDepth },
    (_, index) => `PropagationHop${index + 1}`
  );
  const tableNames = [source, ...hops];
  const structure: Structure = {
    tables: [
      table(source, [numberField(source, 'Amount')]),
      ...hops.map((name, index) =>
        table(
          name,
          propagationHopFields(
            name,
            index === 0 ? source : hops[index - 1]!,
            index === 0 ? 'Amount' : 'Value'
          )
        )
      ),
    ],
  };
  const workload: BenchWorkloadStep[] = [];
  for (let index = 0; index < hops.length; index += 1) {
    workload.push(
      link(
        `setup-link-hop-${index + 1}`,
        hops[index]!,
        'Parent',
        index === hops.length - 1
          ? scenario.size.rows
          : Math.max(3, Math.round(scenario.size.rows / 10)),
        index === 0 ? source : hops[index - 1]!
      )
    );
  }
  workload.push(
    { key: 'setup-flush-computed', kind: 'flush-computed' },
    update('transition-1-update-root', source, 'Amount', 1, 11),
    { key: 'transition-1-flush-computed', kind: 'flush-computed' },
    recomputeCheckpoint({
      scenario,
      transition: 1,
      suffix: 'root-update',
      tables: tableNames,
      description: scenario.workload.mutationSequence[0]!,
      maxRows: scenario.size.rows * tableNames.length,
    })
  );
  for (let index = 0; index < hops.length; index += 1) {
    workload.push(
      recomputeCheckpoint({
        scenario,
        transition: 2,
        suffix: `hop-${index + 1}`,
        tables: tableNames,
        description: `${scenario.workload.mutationSequence[1]!}：${hops[index]}.Value`,
        maxRows: scenario.size.rows * tableNames.length,
      })
    );
  }
  return {
    rootTable: hops.at(-1)!,
    structure,
    dataset: constantDataset(tableNames, source),
    workload,
    oracle: finalOracle(scenario, tableNames, scenario.size.rows * tableNames.length),
  };
}

function branchFields(tableName: string, source: string): ReadonlyArray<Record<string, unknown>> {
  return propagationHopFields(tableName, source, 'Amount');
}

function diamondTemplate(scenario: Scenario): TemplateParts {
  const source = 'DiamondSource';
  const left = 'DiamondLeft';
  const right = 'DiamondRight';
  const join = 'DiamondJoin';
  const tableNames = [source, left, right, join];
  const leftValues = fieldId(join, 'LeftValues');
  const rightValues = fieldId(join, 'RightValues');
  const structure: Structure = {
    tables: [
      table(source, [numberField(source, 'Amount')]),
      table(left, branchFields(left, source)),
      table(right, branchFields(right, source)),
      table(join, [
        linkField(join, 'Left', left),
        lookupField(join, 'LeftValues', 'Left', left, 'Value'),
        linkField(join, 'Right', right),
        lookupField(join, 'RightValues', 'Right', right, 'Value'),
        formulaField(
          join,
          'Value',
          `IF(COUNTA({${leftValues}})>0,SUM({${leftValues}}),0)+IF(COUNTA({${rightValues}})>0,SUM({${rightValues}}),0)`
        ),
      ]),
    ],
  };
  const nonRootRows = Math.max(3, Math.round(scenario.size.rows / 10));
  const maxRows = scenario.size.rows * tableNames.length;
  const workload: BenchWorkloadStep[] = [
    link('setup-left-source', left, 'Parent', nonRootRows, source),
    link('setup-right-source', right, 'Parent', nonRootRows, source),
    link('setup-join-left', join, 'Left', scenario.size.rows, left),
    link('setup-join-right', join, 'Right', scenario.size.rows, right),
    { key: 'setup-flush-computed', kind: 'flush-computed' },
    update('transition-1-update-shared-source', source, 'Amount', 1, 11),
    { key: 'transition-1-flush-computed', kind: 'flush-computed' },
    recomputeCheckpoint({
      scenario,
      transition: 1,
      suffix: 'shared-source',
      tables: tableNames,
      description: scenario.workload.mutationSequence[0]!,
      maxRows,
    }),
    recomputeCheckpoint({
      scenario,
      transition: 2,
      suffix: 'left-branch',
      tables: tableNames,
      description: `${scenario.workload.mutationSequence[1]!}：${left}.Value`,
      maxRows,
    }),
    recomputeCheckpoint({
      scenario,
      transition: 2,
      suffix: 'right-branch',
      tables: tableNames,
      description: `${scenario.workload.mutationSequence[1]!}：${right}.Value`,
      maxRows,
    }),
    recomputeCheckpoint({
      scenario,
      transition: 2,
      suffix: 'join',
      tables: tableNames,
      description: `${scenario.workload.mutationSequence[1]!}：${join}.Value`,
      maxRows,
    }),
  ];
  return {
    rootTable: join,
    structure,
    dataset: constantDataset(tableNames, source),
    workload,
    oracle: finalOracle(scenario, tableNames, maxRows),
  };
}

function highFanoutTemplate(scenario: Scenario): TemplateParts {
  const source = 'FanoutSource';
  const targets = 'FanoutTargets';
  const tableNames = [source, targets];
  const fanout = Math.min(scenario.size.fanout, scenario.size.rows);
  const maxRows = scenario.size.rows * 2;
  const structure: Structure = {
    tables: [
      table(source, [numberField(source, 'Amount')]),
      table(targets, propagationHopFields(targets, source, 'Amount')),
    ],
  };
  return {
    rootTable: targets,
    structure,
    dataset: constantDataset(tableNames, source),
    workload: [
      link('setup-fanout-links', targets, 'Parent', fanout, source),
      { key: 'setup-flush-computed', kind: 'flush-computed' },
      update('transition-1-update-shared-source', source, 'Amount', 1, 11),
      { key: 'transition-1-flush-computed', kind: 'flush-computed' },
      recomputeCheckpoint({
        scenario,
        transition: 1,
        suffix: 'shared-source',
        tables: tableNames,
        description: scenario.workload.mutationSequence[0]!,
        maxRows,
      }),
      recomputeCheckpoint({
        scenario,
        transition: 2,
        suffix: `all-${fanout}-targets`,
        tables: tableNames,
        description: `${scenario.workload.mutationSequence[1]!}：独立全量重算核对 ${fanout} 个受影响目标`,
        maxRows,
      }),
    ],
    oracle: finalOracle(scenario, tableNames, maxRows),
  };
}

function millionRowTemplate(scenario: Scenario): TemplateParts {
  const tableName = 'MillionRowPropagation';
  const amountId = fieldId(tableName, 'Amount');
  const propagatedId = fieldId(tableName, 'Propagated');
  const initialAggregate = 'transition-1-dataset-aggregate';
  const finalAggregate = 'transition-3-independent-aggregate';
  const aggregateDefinition = {
    version: 1,
    kind: 'aggregate',
    tableId: tableName,
    aggregates: [
      { fieldId: propagatedId, statisticFunc: 'count', alias: 'affectedCount' },
      { fieldId: propagatedId, statisticFunc: 'sum', alias: 'valueSum' },
      { fieldId: propagatedId, statisticFunc: 'min', alias: 'valueMin' },
      { fieldId: propagatedId, statisticFunc: 'max', alias: 'valueMax' },
    ],
  };
  return {
    rootTable: tableName,
    structure: {
      tables: [
        table(tableName, [
          numberField(tableName, 'Amount'),
          formulaField(tableName, 'Propagated', `IF({${amountId}},{${amountId}}*2,0)`),
        ]),
      ],
    },
    dataset: constantDataset([tableName], tableName),
    workload: [
      { key: initialAggregate, kind: 'query-structured', definition: aggregateDefinition },
      checkpoint(
        scenario,
        1,
        'deterministic-dataset-aggregate',
        scenario.workload.mutationSequence[0]!,
        {
          kind: 'query-values',
          operations: [initialAggregate],
          expected: [
            {
              affectedCount: scenario.size.rows,
              valueSum: scenario.size.rows * 14,
              valueMin: 14,
              valueMax: 14,
            },
          ],
          ordered: true,
        }
      ),
      update('transition-2-budgeted-source-update', tableName, 'Amount', 1, 11, 1),
      { key: 'transition-2-flush-computed', kind: 'flush-computed' },
      { key: finalAggregate, kind: 'query-structured', definition: aggregateDefinition },
      checkpoint(scenario, 2, 'budgeted-source-update', scenario.workload.mutationSequence[1]!, {
        kind: 'query-values',
        operations: [finalAggregate],
        expected: [
          {
            affectedCount: scenario.size.rows,
            valueSum: scenario.size.rows * 14 + 8,
            valueMin: 14,
            valueMax: 22,
          },
        ],
        ordered: true,
      }),
      checkpoint(
        scenario,
        3,
        'bounded-independent-aggregate',
        scenario.workload.mutationSequence[2]!,
        {
          kind: 'query-values',
          operations: [finalAggregate],
          expected: [
            {
              affectedCount: scenario.size.rows,
              valueSum: scenario.size.rows * 14 + 8,
              valueMin: 14,
              valueMax: 22,
            },
          ],
          ordered: true,
        }
      ),
      update('cleanup-restore-source', tableName, 'Amount', 1, 7, 1),
      { key: 'cleanup-flush-computed', kind: 'flush-computed' },
    ],
    oracle: [
      {
        key: 'catalogue-million-row-row-count-oracle',
        kind: 'invariant',
        checkId: `${scenario.scenarioId}/final`,
        description: scenario.oracle.expected,
        obligationIds: [...scenario.coverageObligationKeys],
        checks: [{ type: 'row-count', table: tableName, expected: scenario.size.rows }],
      },
    ],
  };
}

/** Returns an executable graph-heavy template with bounded checkpoints for extreme cases. */
export function graphTemplateForScenario(scenario: Scenario): GeneratorTemplate | undefined {
  if (scenario.size.rows >= 100_000 && !scenario.resourceBudget.optIn) {
    throw new Error(
      `${scenario.ruleId} at ${scenario.size.rows} rows requires resourceBudget.optIn=true`
    );
  }
  let parts: TemplateParts | undefined;
  switch (scenario.ruleId) {
    case 'R-FORMULA-004':
      parts = formulaDepthTemplate(scenario);
      break;
    case 'R-FORMULA-005':
      parts = formulaWidthTemplate(scenario);
      break;
    case 'R-PROP-001':
      parts = multihopTemplate(scenario);
      break;
    case 'R-PROP-002':
      parts = diamondTemplate(scenario);
      break;
    case 'R-PROP-003':
      parts = highFanoutTemplate(scenario);
      break;
    case 'R-PROP-004':
      parts = millionRowTemplate(scenario);
      break;
    default:
      return undefined;
  }
  return { id: scenario.fixture.reference, ...parts };
}

export type GraphTemplateIntegration =
  | { readonly status: 'not-graph' }
  | { readonly status: 'ready'; readonly template: GeneratorTemplate };

/** Single integration seam for catalogue materialization/readiness wiring. */
export function graphTemplateIntegrationForScenario(scenario: Scenario): GraphTemplateIntegration {
  if (GRAPH_RULE_IDS[scenario.ruleId] !== true) return { status: 'not-graph' };
  if (scenario.size.rows >= 100_000 && !scenario.resourceBudget.optIn) {
    throw new Error(
      `${scenario.ruleId} at ${scenario.size.rows} rows requires resourceBudget.optIn=true`
    );
  }
  const template = graphTemplateForScenario(scenario);
  if (!template) {
    throw new Error(`Missing graph materializer for ${scenario.ruleId}`);
  }
  return { status: 'ready', template };
}
