import { z } from 'zod';

export const TEA_BENCH_IMPACT_GRAPH_SCHEMA_VERSION = 'tea-bench-impact-graph/1' as const;

const NonEmptyStringSchema = z.string().trim().min(1);
const EvidenceSchema = z.enum(['declared', 'estimated', 'observed', 'unknown']);
const CompletenessSchema = z.enum(['complete', 'bounded', 'partial', 'unknown']);

export const ImpactGraphNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: z.enum(['operation', 'table', 'field', 'record', 'runtime']),
    label: NonEmptyStringSchema,
    evidence: EvidenceSchema,
    relation: NonEmptyStringSchema,
    tableId: NonEmptyStringSchema.optional(),
    fieldId: NonEmptyStringSchema.optional(),
    recordId: NonEmptyStringSchema.optional(),
  })
  .strict();

export const ImpactGraphEdgeSchema = z
  .object({
    id: NonEmptyStringSchema,
    from: NonEmptyStringSchema,
    to: NonEmptyStringSchema,
    relation: NonEmptyStringSchema,
    evidence: EvidenceSchema,
    completeness: CompletenessSchema,
    description: NonEmptyStringSchema,
  })
  .strict();

export const OperationImpactGraphSchema = z
  .object({
    operationId: NonEmptyStringSchema,
    executionId: NonEmptyStringSchema,
    key: NonEmptyStringSchema,
    kind: NonEmptyStringSchema,
    order: z.number().int().nonnegative(),
    relation: NonEmptyStringSchema,
    evidence: z.array(EvidenceSchema).min(1),
    completeness: CompletenessSchema,
    nodes: z.array(ImpactGraphNodeSchema),
    edges: z.array(ImpactGraphEdgeSchema),
    notes: z.array(NonEmptyStringSchema),
    explanation: z
      .object({
        title: NonEmptyStringSchema,
        context: NonEmptyStringSchema,
        action: NonEmptyStringSchema,
        sources: z.array(
          z.object({ table: NonEmptyStringSchema, field: z.string().nullable() }).strict()
        ),
        selection: NonEmptyStringSchema,
        valueTransition: NonEmptyStringSchema,
        expected: z.array(
          z.object({ evidence: z.literal('declared'), description: NonEmptyStringSchema }).strict()
        ),
        actual: z.array(
          z
            .object({
              evidence: z.enum(['observed', 'unknown']),
              description: NonEmptyStringSchema,
              checkId: z.string().optional(),
              status: z.string().optional(),
              method: z.string().optional(),
            })
            .strict()
        ),
        notObserved: z.array(NonEmptyStringSchema),
      })
      .strict(),
  })
  .strict()
  .superRefine((graph, context) => {
    const nodeIds = new Set(graph.nodes.map((node) => node.id));
    if (nodeIds.size !== graph.nodes.length) {
      context.addIssue({ code: 'custom', path: ['nodes'], message: 'node IDs must be unique' });
    }
    for (const [index, edge] of graph.edges.entries()) {
      if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
        context.addIssue({
          code: 'custom',
          path: ['edges', index],
          message: 'edges must reference graph nodes',
        });
      }
    }
  });

export const TeaBenchImpactGraphSchema = z
  .object({
    schema: z.literal(TEA_BENCH_IMPACT_GRAPH_SCHEMA_VERSION),
    reportSchema: z.literal('tea-bench-report/2'),
    executionId: NonEmptyStringSchema,
    caseId: NonEmptyStringSchema,
    runId: NonEmptyStringSchema,
    limits: z
      .object({
        maxRecordNodesPerOperation: z.number().int().positive(),
        maxNodesPerOperation: z.number().int().positive(),
        maxEdgesPerOperation: z.number().int().positive(),
      })
      .strict(),
    graphs: z.record(NonEmptyStringSchema, OperationImpactGraphSchema),
    steps: z.array(
      z
        .object({
          order: z.number().int().nonnegative(),
          key: NonEmptyStringSchema,
          kind: NonEmptyStringSchema,
          measured: z.boolean(),
          operationId: z.string().nullable(),
          title: NonEmptyStringSchema,
          description: NonEmptyStringSchema,
          checkId: z.string().nullable(),
          method: z.string().nullable(),
          statuses: z.array(z.string()),
          chain: z.array(z.string()),
          expectationEvidence: z.literal('declared'),
          verdictEvidence: z.enum(['observed', 'unknown']),
        })
        .strict()
    ),
    correctnessSteps: z.array(
      z
        .object({
          key: NonEmptyStringSchema,
          kind: z.literal('expect-error'),
          measured: z.literal(false),
          description: NonEmptyStringSchema,
          expectationEvidence: z.literal('declared'),
          verdictEvidence: z.literal('observed'),
          checkIds: z.array(z.string()),
          statuses: z.array(z.string()),
        })
        .strict()
    ),
  })
  .strict()
  .superRefine((sidecar, context) => {
    for (const [key, graph] of Object.entries(sidecar.graphs)) {
      if (key !== graph.operationId) {
        context.addIssue({
          code: 'custom',
          path: ['graphs', key, 'operationId'],
          message: 'graph key must equal operationId',
        });
      }
      if (graph.nodes.length > sidecar.limits.maxNodesPerOperation) {
        context.addIssue({
          code: 'custom',
          path: ['graphs', key, 'nodes'],
          message: 'graph exceeds node limit',
        });
      }
      if (graph.edges.length > sidecar.limits.maxEdgesPerOperation) {
        context.addIssue({
          code: 'custom',
          path: ['graphs', key, 'edges'],
          message: 'graph exceeds edge limit',
        });
      }
    }
  });

export type ImpactEvidence = z.infer<typeof EvidenceSchema>;
export type ImpactGraphNode = z.infer<typeof ImpactGraphNodeSchema>;
export type ImpactGraphEdge = z.infer<typeof ImpactGraphEdgeSchema>;
export type OperationImpactGraph = z.infer<typeof OperationImpactGraphSchema>;
export type TeaBenchImpactGraph = z.infer<typeof TeaBenchImpactGraphSchema>;

export const parseTeaBenchImpactGraph = (input: unknown): TeaBenchImpactGraph =>
  TeaBenchImpactGraphSchema.parse(input);
