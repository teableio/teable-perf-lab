import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import { ruleRegistry } from './registry';
import {
  CatalogueGraphSchema,
  CoverageObligationSchema,
  GraphCoverageReceiptSchema,
  type CatalogueGraph,
  type CoverageObligation,
  type GraphCoverageReceipt,
  type Rule,
} from './schema';

export type DeriveObligationsOptions = {
  readonly maxSearchStates?: number;
};

export type DerivedObligations = {
  readonly obligations: ReadonlyArray<CoverageObligation>;
  readonly receipt: GraphCoverageReceipt;
};

type FieldNode = {
  readonly tableId: string;
  readonly fieldId: string;
  readonly kind: string;
  readonly writable: boolean;
};
type Edge = {
  readonly edgeId: string;
  readonly from: string;
  readonly target: FieldNode;
};
type ReachableEdge = Edge & { readonly depth: number };
const supportedSourceKinds: Readonly<Record<string, true>> = {
  singleLineText: true,
  longText: true,
  number: true,
  checkbox: true,
  date: true,
  singleSelect: true,
  multipleSelect: true,
  link: true,
};
const targetKindByFamily: Partial<Record<Rule['family'], Readonly<Record<string, true>>>> = {
  formula: { formula: true },
  lookup: { lookup: true },
  rollup: { rollup: true },
  ['conditional-link']: {
    conditionalLink: true,
    conditionalLookup: true,
    conditionalRollup: true,
  },
  propagation: {
    formula: true,
    lookup: true,
    rollup: true,
    conditionalLink: true,
    conditionalLookup: true,
    conditionalRollup: true,
  },
};
function nodeKey(tableId: string, fieldId: string): string {
  return `${tableId}\u0000${fieldId}`;
}

function obligationKey(input: Omit<CoverageObligation, 'obligationKey'>): string {
  return `obl_${sha256Hex(canonicalJson(input))}`;
}

function makeObligation(input: Omit<CoverageObligation, 'obligationKey'>): CoverageObligation {
  return CoverageObligationSchema.parse({ ...input, obligationKey: obligationKey(input) });
}

function appliesToTarget(rule: Rule, targetKind: string): boolean {
  return targetKindByFamily[rule.family]?.[targetKind] === true;
}

function indexGraph(
  graph: CatalogueGraph,
  maxSearchStates: number
): {
  fields: Map<string, FieldNode>;
  outgoing: Map<string, Edge[]>;
  discoveredEdges: number;
  truncated: boolean;
} {
  const fields = new Map<string, FieldNode>();
  const outgoing = new Map<string, Edge[]>();
  for (const table of graph.tables) {
    for (const field of table.fields) {
      fields.set(nodeKey(table.tableId, field.fieldId), {
        tableId: table.tableId,
        fieldId: field.fieldId,
        kind: field.kind,
        writable: field.writable,
      });
    }
  }
  let discoveredEdges = 0;
  let truncated = false;
  for (const table of graph.tables) {
    for (const targetField of table.fields) {
      const target = fields.get(nodeKey(table.tableId, targetField.fieldId))!;
      for (const dependency of targetField.dependencies) {
        if (discoveredEdges >= maxSearchStates) {
          truncated = true;
          return { fields, outgoing, discoveredEdges, truncated };
        }
        const from = nodeKey(dependency.tableId, dependency.fieldId);
        const edges = outgoing.get(from) ?? [];
        edges.push({ edgeId: dependency.edgeId, from, target });
        outgoing.set(from, edges);
        discoveredEdges += 1;
      }
    }
  }
  for (const edges of outgoing.values()) {
    edges.sort((left, right) =>
      canonicalJson([left.target.tableId, left.target.fieldId, left.edgeId]).localeCompare(
        canonicalJson([right.target.tableId, right.target.fieldId, right.edgeId])
      )
    );
  }
  return { fields, outgoing, discoveredEdges, truncated };
}

function reachableEdges(input: {
  source: FieldNode;
  outgoing: ReadonlyMap<string, ReadonlyArray<Edge>>;
  searchStates: number;
  maxSearchStates: number;
}): { edges: ReachableEdge[]; searchStates: number; truncated: boolean } {
  const sourceKey = nodeKey(input.source.tableId, input.source.fieldId);
  const edges: ReachableEdge[] = [];
  const seenDepth = new Map([[sourceKey, 0]]);
  const queue: Array<{ key: string; depth: number }> = [{ key: sourceKey, depth: 0 }];
  let cursor = 0;
  let searchStates = input.searchStates;
  while (cursor < queue.length && searchStates < input.maxSearchStates) {
    const current = queue[cursor++]!;
    searchStates += 1;
    for (const edge of input.outgoing.get(current.key) ?? []) {
      const depth = current.depth + 1;
      edges.push({ ...edge, depth });
      const targetKey = nodeKey(edge.target.tableId, edge.target.fieldId);
      const previousDepth = seenDepth.get(targetKey);
      if (previousDepth === undefined || depth < previousDepth) {
        seenDepth.set(targetKey, depth);
        queue.push({ key: targetKey, depth });
      }
    }
  }
  return { edges, searchStates, truncated: cursor < queue.length };
}

function obligationsForSource(
  source: FieldNode,
  reachedEdges: ReadonlyArray<ReachableEdge>
): CoverageObligation[] {
  return ruleRegistry.rules.flatMap((rule) => {
    const common = {
      ruleId: rule.ruleId,
      source: { tableId: source.tableId, fieldId: source.fieldId },
      mutationClass: rule.mutationClass,
      interaction: rule.interaction,
    } as const;
    if (!supportedSourceKinds[source.kind]) {
      return [
        makeObligation({
          ...common,
          impactedTarget: { tableId: source.tableId, fieldId: source.fieldId, edgeId: null },
          applicability: 'unsupported',
          reason: `源字段类型 ${source.kind} 没有声明可执行写入适配器`,
        }),
      ];
    }
    const directFamily =
      rule.family === 'storage-query' || rule.family === 'write' || rule.family === 'api-limit';
    const typecastKinds: Readonly<Record<string, true>> = {
      singleLineText: true,
      number: true,
      date: true,
      singleSelect: true,
      multipleSelect: true,
    };
    const directApplicable =
      directFamily &&
      (rule.mutationClass !== 'link-membership' || source.kind === 'link') &&
      (rule.mutationClass !== 'typecast' || typecastKinds[source.kind] === true);
    if (directFamily) {
      return [
        makeObligation({
          ...common,
          impactedTarget: { tableId: source.tableId, fieldId: source.fieldId, edgeId: null },
          applicability: directApplicable ? 'applicable' : 'inapplicable',
          reason: directApplicable
            ? '源字段满足规则声明的结构和类型前置条件'
            : `源字段类型 ${source.kind} 不满足 ${rule.ruleId} 的结构或类型前置条件`,
        }),
      ];
    }
    const matchingEdges = reachedEdges.filter(
      (edge) =>
        appliesToTarget(rule, edge.target.kind) &&
        (rule.ruleId !== 'R-PROP-001' || edge.depth >= 4) &&
        (rule.ruleId !== 'R-FORMULA-004' || edge.depth >= 32) &&
        (rule.mutationClass !== 'link-membership' || source.kind === 'link')
    );
    if (matchingEdges.length === 0) {
      return [
        makeObligation({
          ...common,
          impactedTarget: { tableId: source.tableId, fieldId: source.fieldId, edgeId: null },
          applicability: 'inapplicable',
          reason: `从该源没有可达的 ${rule.family} 目标边`,
        }),
      ];
    }
    return matchingEdges.map((edge) =>
      makeObligation({
        ...common,
        impactedTarget: {
          tableId: edge.target.tableId,
          fieldId: edge.target.fieldId,
          edgeId: edge.edgeId,
        },
        applicability: 'applicable',
        reason: `源变更可经已声明依赖到达目标 ${edge.target.tableId}/${edge.target.fieldId}`,
      })
    );
  });
}
/**
 * 从每个可写源做一次有界可达遍历。节点至多入队一次，但每条声明边都会被记录，
 * 因此菱形图不会展开为路径组合，汇合边也不会被相似分桶吞掉。
 */
export function deriveCoverageObligations(
  graphInput: CatalogueGraph,
  options: DeriveObligationsOptions = {}
): DerivedObligations {
  const graph = CatalogueGraphSchema.parse(graphInput);
  const maxSearchStates = options.maxSearchStates ?? 100_000;
  const indexed = indexGraph(graph, maxSearchStates);
  const sources = [...indexed.fields.values()]
    .filter((field) => field.writable)
    .sort((left, right) =>
      nodeKey(left.tableId, left.fieldId).localeCompare(nodeKey(right.tableId, right.fieldId))
    );
  const obligations: CoverageObligation[] = [];
  const gaps: string[] = indexed.truncated
    ? [`依赖边构建达到 ${maxSearchStates} 个工作状态；剩余边的适用性未知，不计为不适用`]
    : [];
  let searchStates = indexed.discoveredEdges;
  let truncated = indexed.truncated;

  for (const source of sources) {
    const reachable = reachableEdges({
      source,
      outgoing: indexed.outgoing,
      searchStates,
      maxSearchStates,
    });
    searchStates = reachable.searchStates;
    truncated ||= reachable.truncated;
    if (reachable.truncated) {
      gaps.push(
        `源 ${source.tableId}/${source.fieldId} 的依赖遍历达到 ${maxSearchStates} 个搜索状态`
      );
    }
    obligations.push(...obligationsForSource(source, reachable.edges));
  }

  const applicable = obligations.filter((item) => item.applicability === 'applicable').length;
  const inapplicable = obligations.filter((item) => item.applicability === 'inapplicable').length;
  const unsupported = obligations.filter((item) => item.applicability === 'unsupported').length;
  const receipt = GraphCoverageReceiptSchema.parse({
    requestedRules: ruleRegistry.rules.length,
    declaredSources: sources.length,
    discoveredEdges: indexed.discoveredEdges,
    applicableObligations: applicable,
    inapplicableObligations: inapplicable,
    unsupportedObligations: unsupported,
    plannedObligations: 0,
    executedObligations: 0,
    assertionVerifiedObligations: 0,
    notExecutedObligations: applicable,
    truncated,
    searchStates,
    maxSearchStates,
    gaps,
  });
  return { obligations, receipt };
}

export function receiptForCoveragePlan(input: {
  derived: DerivedObligations;
  plannedObligationKeys: ReadonlySet<string>;
  executedObligationKeys?: ReadonlySet<string>;
  verifiedObligationKeys?: ReadonlySet<string>;
}): GraphCoverageReceipt {
  const applicable = input.derived.obligations.filter(
    (item) => item.applicability === 'applicable'
  );
  const executed = input.executedObligationKeys ?? new Set<string>();
  const verified = input.verifiedObligationKeys ?? new Set<string>();
  const plannedCount = applicable.filter((item) =>
    input.plannedObligationKeys.has(item.obligationKey)
  ).length;
  const executedCount = applicable.filter((item) => executed.has(item.obligationKey)).length;
  const verifiedCount = applicable.filter((item) => verified.has(item.obligationKey)).length;
  const gaps = [
    ...input.derived.receipt.gaps,
    ...findCoverageGaps(input.derived.obligations, input.plannedObligationKeys, verified),
  ];
  return GraphCoverageReceiptSchema.parse({
    ...input.derived.receipt,
    plannedObligations: plannedCount,
    executedObligations: executedCount,
    assertionVerifiedObligations: verifiedCount,
    notExecutedObligations: applicable.length - executedCount,
    gaps,
  });
}

export function findCoverageGaps(
  obligations: ReadonlyArray<CoverageObligation>,
  plannedObligationKeys: ReadonlySet<string>,
  verifiedObligationKeys: ReadonlySet<string> = new Set()
): ReadonlyArray<string> {
  return obligations
    .filter((item) => item.applicability === 'applicable')
    .flatMap((item) => {
      if (!plannedObligationKeys.has(item.obligationKey)) {
        return [
          `未计划：${item.obligationKey}（${item.ruleId}，${item.source.tableId}/${item.source.fieldId} → ${item.impactedTarget.tableId}/${item.impactedTarget.fieldId}）`,
        ];
      }
      if (!verifiedObligationKeys.has(item.obligationKey)) {
        return [`未执行或未验证：${item.obligationKey}（${item.ruleId}）`];
      }
      return [];
    });
}
