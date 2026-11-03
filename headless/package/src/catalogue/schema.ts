import { z } from 'zod';

export const CATALOGUE_SCHEMA_VERSION = '1.0.0' as const;
export const RULE_REGISTRY_VERSION = 'teable-headless-rules/1' as const;
export const CATALOGUE_GENERATOR_VERSION = 'teable-headless-catalogue/1' as const;

export const SeverityTagSchema = z.enum(['normal', 'boundary', 'extreme', 'rare']);
export const BehaviorFamilySchema = z.enum([
  'storage-query',
  'write',
  'formula',
  'lookup',
  'rollup',
  'conditional-link',
  'propagation',
  'api-limit',
]);
export const MutationClassSchema = z.enum([
  'read',
  'create',
  'update',
  'delete',
  'typecast',
  'batch',
  'clear-restore',
  'parent-update',
  'link-membership',
  'condition-transition',
  'propagate',
  'limit',
]);
export const InteractionStrengthSchema = z.object({
  kind: z.enum(['single', 'pairwise', 'three-way', 'forced']),
  strength: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  reason: z.string().min(1),
});

export const RuleSchema = z.object({
  ruleId: z.string().regex(/^R-[A-Z]+-\d{3}$/),
  title: z.string().min(1),
  description: z.string().min(1),
  family: BehaviorFamilySchema,
  severity: z.array(SeverityTagSchema).min(1),
  applicability: z.object({
    sourceKinds: z.array(z.string().min(1)).min(1),
    targetKinds: z.array(z.string().min(1)),
    relationshipKinds: z.array(z.string().min(1)),
    predicate: z.string().min(1),
  }),
  mutationClass: MutationClassSchema,
  mutationBoundary: z.string().min(1),
  transitionSequence: z.array(z.string().min(1)).min(1),
  oracle: z.object({
    strategy: z.enum(['exact-values', 'full-recompute', 'negative-error', 'query-result']),
    assertions: z.array(z.string().min(1)).min(1),
    permitsNull: z.boolean(),
  }),
  scope: z.array(z.string().min(1)).min(1),
  exclusions: z.array(z.string().min(1)),
  interaction: InteractionStrengthSchema,
  templateId: z.string().min(1),
  supported: z.boolean(),
  unsupportedReason: z.string().min(1).optional(),
});

export const KnownGapSchema = z.object({
  gapId: z.string().regex(/^GAP-[A-Z]+-\d{3}$/),
  title: z.string().min(1),
  reason: z.string().min(1),
  excludedBehavior: z.string().min(1),
});

export const RuleRegistrySchema = z.object({
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  registryVersion: z.literal(RULE_REGISTRY_VERSION),
  title: z.string().min(1),
  scope: z.array(z.string().min(1)).min(1),
  exclusions: z.array(z.string().min(1)).min(1),
  rules: z.array(RuleSchema).min(1),
  knownGaps: z.array(KnownGapSchema).min(1),
});

export const DependencyRefSchema = z.object({
  tableId: z.string().min(1),
  fieldId: z.string().min(1),
  edgeId: z.string().min(1),
  relationship: z.enum(['same-record', 'lookup', 'rollup', 'conditional', 'link']).optional(),
});
export const CatalogueFieldSchema = z.object({
  fieldId: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  writable: z.boolean(),
  nullable: z.boolean(),
  dependencies: z.array(DependencyRefSchema).default([]),
});
export const CatalogueTableSchema = z.object({
  tableId: z.string().min(1),
  name: z.string().min(1),
  fields: z.array(CatalogueFieldSchema).min(1),
});
export const CatalogueGraphSchema = z.object({
  schemaId: z.string().min(1),
  replayMode: z.enum(['synthetic-data', 'original-csv']),
  tables: z.array(CatalogueTableSchema).min(1),
});

export const CoverageObligationSchema = z.object({
  obligationKey: z.string().regex(/^obl_[a-f0-9]{64}$/),
  ruleId: z.string().min(1),
  source: z.object({ tableId: z.string().min(1), fieldId: z.string().min(1) }),
  mutationClass: MutationClassSchema,
  impactedTarget: z.object({
    tableId: z.string().min(1),
    fieldId: z.string().min(1),
    edgeId: z.string().min(1).nullable(),
  }),
  applicability: z.enum(['applicable', 'inapplicable', 'unsupported']),
  reason: z.string().min(1),
  interaction: InteractionStrengthSchema,
});

export const GraphCoverageReceiptSchema = z.object({
  requestedRules: z.number().int().nonnegative(),
  declaredSources: z.number().int().nonnegative(),
  discoveredEdges: z.number().int().nonnegative(),
  applicableObligations: z.number().int().nonnegative(),
  inapplicableObligations: z.number().int().nonnegative(),
  unsupportedObligations: z.number().int().nonnegative(),
  plannedObligations: z.number().int().nonnegative(),
  executedObligations: z.number().int().nonnegative(),
  assertionVerifiedObligations: z.number().int().nonnegative(),
  notExecutedObligations: z.number().int().nonnegative(),
  truncated: z.boolean(),
  searchStates: z.number().int().nonnegative(),
  maxSearchStates: z.number().int().positive(),
  gaps: z.array(z.string().min(1)),
});

const ScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const ScenarioSchema = z.object({
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  generatorVersion: z.literal(CATALOGUE_GENERATOR_VERSION),
  ruleRegistryVersion: z.literal(RULE_REGISTRY_VERSION),
  scenarioId: z.string().regex(/^scn_[a-f0-9]{64}$/),
  ruleId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  severity: z.array(SeverityTagSchema).min(1),
  family: BehaviorFamilySchema,
  executionStatus: z.enum(['planned', 'verified', 'unsupported', 'failed']),
  evidenceKind: z.enum(['exact-test-data', 'observed']),
  unsupportedReason: z.string().min(1).optional(),
  distinctnessReason: z.object({
    behaviorInput: z.string().min(1),
    shapeInput: z.string().min(1),
    workloadInput: z.string().min(1),
    oracleInput: z.string().min(1),
  }),
  structuralIdentity: z.string().min(1),
  coverageObligationKeys: z.array(z.string().min(1)).min(1),
  applicability: z.object({ applicable: z.boolean(), reason: z.string().min(1) }),
  interaction: InteractionStrengthSchema,
  profile: z.object({
    distribution: z.enum(['uniform', 'zipf', 'hotspot', 'sparse']),
    cardinality: z.enum(['low', 'medium', 'high']),
    textWidth: z.union([z.literal(16), z.literal(256), z.literal(4096)]),
  }),
  size: z.object({
    rows: z.union([
      z.literal(0),
      z.literal(100),
      z.literal(10_000),
      z.literal(100_000),
      z.literal(1_000_000),
    ]),
    graphDepth: z.number().int().nonnegative(),
    graphWidth: z.number().int().positive(),
    fanout: z.number().int().nonnegative(),
  }),
  resourceBudget: z.object({
    optIn: z.boolean(),
    maxDurationMs: z.number().int().positive(),
    maxMemoryMb: z.number().int().positive(),
    maxOperations: z.number().int().positive(),
  }),
  fixture: z.object({
    kind: z.enum(['deterministic-template', 'named-unsupported-gap']),
    reference: z.string().min(1),
    revision: z.string().min(1),
    parameters: z.record(z.string(), ScalarSchema),
  }),
  workload: z.object({
    mutationSequence: z.array(z.string().min(1)).min(1),
    operation: z.string().min(1),
    targetRows: z.number().int().nonnegative(),
    batchSize: z.number().int().positive(),
    queryShape: z.string().min(1),
  }),
  oracle: z.object({
    strategy: z.enum(['exact-values', 'full-recompute', 'negative-error', 'query-result']),
    expected: z.string().min(1),
    expectedRows: z.number().int().nonnegative(),
    permitsNull: z.boolean(),
    assertions: z.array(z.string().min(1)).min(1),
  }),
});

export const FactorDomainSchema = z.object({
  name: z.string().min(1),
  values: z.array(z.union([z.string(), z.number()])).min(1),
});
export const CatalogueReceiptSchema = z
  .object({
    requested: z.number().int().nonnegative(),
    applicable: z.number().int().nonnegative(),
    planned: z.number().int().nonnegative(),
    executed: z.number().int().nonnegative(),
    pass: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    requestedRules: z.number().int().nonnegative(),
    applicableRules: z.number().int().nonnegative(),
    pairwiseRuleIds: z.array(z.string().min(1)),
    factorDomains: z.array(FactorDomainSchema).min(2),
    rawPairCountFormula: z.string().min(1),
    rawPairCount: z.number().int().nonnegative(),
    completable: z.number().int().nonnegative(),
    plannedPairCount: z.number().int().nonnegative(),
    executedPairVerifiedCount: z.number().int().nonnegative(),
    nonCompletable: z.number().int().nonnegative(),
    truncated: z.boolean(),
    searchStates: z.number().int().nonnegative(),
    bounds: z.object({
      maxCases: z.number().int().positive(),
      maxSearchStates: z.number().int().positive(),
      maxMillis: z.number().int().positive(),
    }),
    gaps: z.array(z.string().min(1)),
  })
  .superRefine((receipt, context) => {
    if (receipt.planned > receipt.applicable || receipt.applicable > receipt.requested) {
      context.addIssue({ code: 'custom', message: '必须满足 planned <= applicable <= requested' });
    }
    if (receipt.executed > receipt.planned) {
      context.addIssue({ code: 'custom', message: 'executed 不能超过 planned' });
    }
    if (receipt.skipped + receipt.unsupported > receipt.requested) {
      context.addIssue({ code: 'custom', message: 'skipped 与 unsupported 不能超过 requested' });
    }
    if (receipt.pass + receipt.fail > receipt.executed) {
      context.addIssue({ code: 'custom', message: '执行结果计数不守恒' });
    }
    if (receipt.completable + receipt.nonCompletable !== receipt.rawPairCount) {
      context.addIssue({ code: 'custom', message: '成对覆盖计数不守恒' });
    }
    if (receipt.plannedPairCount > receipt.completable) {
      context.addIssue({ code: 'custom', message: 'plannedPairCount 不能超过 completable' });
    }
    if (receipt.executedPairVerifiedCount > receipt.plannedPairCount) {
      context.addIssue({
        code: 'custom',
        message: 'executedPairVerifiedCount 不能超过 plannedPairCount',
      });
    }
  });

export const ScenarioCatalogueSchema = z.object({
  schemaVersion: z.literal(CATALOGUE_SCHEMA_VERSION),
  generatorVersion: z.literal(CATALOGUE_GENERATOR_VERSION),
  ruleRegistryVersion: z.literal(RULE_REGISTRY_VERSION),
  scenarios: z.array(ScenarioSchema),
  receipt: CatalogueReceiptSchema,
});

export type Rule = z.infer<typeof RuleSchema>;
export type RuleRegistry = z.infer<typeof RuleRegistrySchema>;
export type CatalogueGraph = z.infer<typeof CatalogueGraphSchema>;
export type CoverageObligation = z.infer<typeof CoverageObligationSchema>;
export type GraphCoverageReceipt = z.infer<typeof GraphCoverageReceiptSchema>;
export type Scenario = z.infer<typeof ScenarioSchema>;
export type CatalogueReceipt = z.infer<typeof CatalogueReceiptSchema>;
export type ScenarioCatalogue = z.infer<typeof ScenarioCatalogueSchema>;
