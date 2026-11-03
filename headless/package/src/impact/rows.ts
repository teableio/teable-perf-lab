import type { TeaBenchImpactGraph } from './schema';

export type TeaBenchImpactRows = {
  readonly operationRows: ReadonlyArray<Record<string, string | number>>;
  readonly nodeRows: ReadonlyArray<Record<string, string | number | null>>;
  readonly edgeRows: ReadonlyArray<Record<string, string>>;
};

export function exportTeaBenchImpactRows(sidecar: TeaBenchImpactGraph): TeaBenchImpactRows {
  return {
    operationRows: Object.values(sidecar.graphs).map((graph) => ({
      operationId: graph.operationId,
      executionId: graph.executionId,
      key: graph.key,
      kind: graph.kind,
      order: graph.order,
      relation: graph.relation,
      evidence: graph.evidence.join(','),
      completeness: graph.completeness,
      notesJson: JSON.stringify(graph.notes),
      explanationJson: JSON.stringify(graph.explanation),
    })),
    nodeRows: Object.values(sidecar.graphs).flatMap((graph) =>
      graph.nodes.map((node) => ({
        operationId: graph.operationId,
        nodeId: node.id,
        kind: node.kind,
        label: node.label,
        evidence: node.evidence,
        relation: node.relation,
        tableId: node.tableId ?? null,
        fieldId: node.fieldId ?? null,
        recordId: node.recordId ?? null,
      }))
    ),
    edgeRows: Object.values(sidecar.graphs).flatMap((graph) =>
      graph.edges.map((edge) => ({
        operationId: graph.operationId,
        edgeId: edge.id,
        from: edge.from,
        to: edge.to,
        relation: edge.relation,
        evidence: edge.evidence,
        completeness: edge.completeness,
        description: edge.description,
      }))
    ),
  };
}
