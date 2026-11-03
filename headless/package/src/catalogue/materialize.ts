import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';

import { canonicalJson, sha256Hex } from '../case/canonicalJson';
import {
  computeCaseId,
  computeDatasetHash,
  parseBenchCaseManifest,
  type BenchCaseManifest,
} from '../case/manifest';
import { generateCoveringArray } from '../generator/coveringArray';
import type { GeneratedCase, GeneratorCoverage } from '../generator/generate';
import { readTeaArchive } from '../tea/teaZip';
import { ScenarioSchema, type Scenario } from './schema';
import { catalogueTemplateForScenario, CATALOGUE_SAMPLES } from './templates';
import { graphTemplateIntegrationForScenario } from './templatesGraph';
import { queryWriteTemplateForScenario } from './templatesQueryWrite';

/** Only complete, checkpointed sequences are executable; legacy template names are not aliases. */
export const runnableTemplateByRule: Readonly<Record<string, string>> = {
  ['R-QUERY-001']: 'catalogue-storage-read',
  ['R-QUERY-002']: 'catalogue-storage-filter',
  ['R-QUERY-003']: 'catalogue-storage-sort',
  ['R-QUERY-004']: 'catalogue-storage-page',
  ['R-QUERY-005']: 'catalogue-structured-query',
  ['R-WRITE-001']: 'catalogue-write-create',
  ['R-WRITE-002']: 'catalogue-write-update',
  ['R-WRITE-003']: 'catalogue-write-delete',
  ['R-WRITE-004']: 'catalogue-write-typecast-valid',
  ['R-WRITE-005']: 'catalogue-write-typecast-invalid',
  ['R-WRITE-006']: 'catalogue-write-batch-boundary',
  ['R-WRITE-007']: 'catalogue-source-clear-restore',
  ['R-FORMULA-001']: 'catalogue-formula-source',
  ['R-FORMULA-002']: 'catalogue-formula-null-restore',
  ['R-LINK-001']: 'catalogue-lookup-parent-update',
  ['R-LINK-002']: 'catalogue-link-membership-sequence',
  ['R-LINK-003']: 'catalogue-link-clear-all',
  ['R-ROLLUP-001']: 'catalogue-rollup-cardinality',
  ['R-ROLLUP-002']: 'catalogue-rollup-value-update',
  ['R-COND-001']: 'catalogue-conditional-enter-leave',
  ['R-COND-002']: 'catalogue-conditional-empty',
  ['R-FORMULA-003']: 'catalogue-formula-error-restore',
  ['R-FORMULA-004']: 'catalogue-formula-depth',
  ['R-FORMULA-005']: 'catalogue-formula-width',
  ['R-FORMULA-006']: 'catalogue-formula-type-boundary',
  ['R-PROP-001']: 'catalogue-multihop-propagation',
  ['R-PROP-002']: 'catalogue-diamond-propagation',
  ['R-PROP-003']: 'catalogue-high-fanout',
  ['R-PROP-004']: 'catalogue-million-row-propagation',
  ['R-LIMIT-001']: 'catalogue-api-batch-limit',
  ['R-LIMIT-002']: 'catalogue-api-page-limit',
};

export const supportedRuleIds: ReadonlyArray<string> = Object.freeze(
  Object.keys(runnableTemplateByRule).sort()
);

export const unsupportedReasonByRule: Readonly<Record<string, string>> = {
  ['R-FORMULA-004']: 'Depth-32 template is opt-in; full-size execution is not automatic.',
  ['R-FORMULA-005']: 'Width-128 template is opt-in; full-size execution is not automatic.',
  ['R-PROP-001']: 'Four-hop template is opt-in; verify bounded execution.',
  ['R-PROP-002']: 'Diamond template is opt-in; verify bounded execution.',
  ['R-PROP-003']: 'Fanout-10000 template is opt-in; verify bounded execution.',
  ['R-PROP-004']:
    'Million-row aggregate template is opt-in; full-size execution remains not-executed by policy.',
};

export type MaterializerReadiness = {
  readonly completeTransitionAssertions: boolean;
  readonly supportsExpectedErrors: boolean;
  readonly supportsLinkMembership: boolean;
  readonly supportsCursor: boolean;
};
export const materializerReadiness: MaterializerReadiness = {
  completeTransitionAssertions: true,
  supportsExpectedErrors: true,
  supportsLinkMembership: true,
  supportsCursor: true,
};
export function isMaterializableRule(ruleId: string): boolean {
  return Object.prototype.hasOwnProperty.call(runnableTemplateByRule, ruleId);
}

const structureSchema = z
  .object({
    tables: z.array(
      z
        .object({
          id: z.string().regex(/^tbl[A-Za-z0-9]{16}$/),
          name: z.string().min(1),
          fields: z.array(
            z
              .object({
                id: z.string().regex(/^fld[A-Za-z0-9]{16}$/),
                name: z.string().min(1),
                type: z.string().min(1),
                cellValueType: z.string().optional(),
              })
              .passthrough()
          ),
        })
        .passthrough()
    ),
  })
  .passthrough()
  .superRefine((structure, context) => {
    const ids = new Set<string>();
    for (const table of structure.tables) {
      for (const entry of [table, ...table.fields]) {
        if (ids.has(entry.id))
          context.addIssue({ code: 'custom', message: `Duplicate catalogue ID ${entry.id}` });
        ids.add(entry.id);
      }
      for (const field of table.fields) {
        if (field.type === 'formula' && field.cellValueType === undefined) {
          context.addIssue({
            code: 'custom',
            message: `Formula ${field.id} requires cellValueType`,
          });
        }
      }
    }
  });

/** Materializes one scenario, not a Cartesian product of nuisance factors. */
export async function materializeCatalogueScenario(input: {
  scenario: Scenario;
  outDir: string;
}): Promise<{ cases: ReadonlyArray<GeneratedCase>; coverage: GeneratorCoverage }> {
  const scenario = ScenarioSchema.parse(input.scenario);
  if (!isMaterializableRule(scenario.ruleId)) {
    throw new Error(
      `Scenario ${scenario.scenarioId}: ${unsupportedReasonByRule[scenario.ruleId] ?? `No materializer for ${scenario.ruleId}`}`
    );
  }
  if (scenario.size.rows === 0 && scenario.family !== 'storage-query') {
    throw new Error(
      `Scenario ${scenario.scenarioId}: ${scenario.ruleId} requires source rows; requested exactly zero`
    );
  }
  const graphIntegration = graphTemplateIntegrationForScenario(scenario);
  const template =
    graphIntegration.status === 'ready'
      ? graphIntegration.template
      : (queryWriteTemplateForScenario(scenario) ?? catalogueTemplateForScenario(scenario));
  if (!template) throw new Error(`Missing advertised materializer ${scenario.ruleId}`);
  const structure = structureSchema.parse(template.structure);
  const rows = Object.fromEntries(
    structure.tables.map((table) => [
      table.name,
      table.name === template.rootTable
        ? scenario.size.rows
        : Math.max(3, Math.round(scenario.size.rows / 10)),
    ])
  );
  const seed = { schema: 7, data: 7, query: 7, schedule: 7 };
  const draft = parseBenchCaseManifest({
    caseId: `sha256:${'0'.repeat(64)}`,
    specVersion: 1,
    generatorVersion: scenario.generatorVersion,
    title: `${scenario.ruleId}: ${scenario.title}`,
    dimensions: {
      scenarioId: scenario.scenarioId,
      ruleId: scenario.ruleId,
      coverageObligationKeys: scenario.coverageObligationKeys,
      rows: scenario.size.rows,
      profile: scenario.profile,
      ...(scenario.fixture.parameters.complexityAssumptionWriteKey === undefined
        ? {}
        : {
            complexityAssumptions: {
              changeRateByOperation: {
                [String(scenario.fixture.parameters.complexityAssumptionWriteKey)]: {
                  value: scenario.fixture.parameters.complexityAssumptionChangeRate,
                  source: scenario.fixture.parameters.complexityAssumptionSource,
                  evidence: scenario.fixture.parameters.complexityAssumptionEvidence,
                },
              },
            },
          }),
    },
    source: { tea: 'fixture.tea', dataMode: 'recipe' },
    dataset: { rows, seed, recipe: template.dataset },
    run: {
      backend: 'pglite',
      samples: CATALOGUE_SAMPLES,
      warmup: 1,
      repetitions: 1,
      seedBatchSize: 1000,
      actorId: 'usr_headless',
    },
    workload: template.workload,
    oracle: template.oracle,
    links: { requirementIds: scenario.coverageObligationKeys },
  });
  const dir = join(input.outDir, scenario.scenarioId);
  const teaPath = join(dir, 'fixture.tea');
  const manifestPath = join(dir, 'case.manifest.json');
  // ZIP dates are explicit so identical scenarios have byte-identical archives across runs.
  const tea = zipSync(
    {
      ['structure.json']: [
        strToU8(JSON.stringify(structure, null, 2)),
        { mtime: new Date('1980-01-01T00:00:00Z') },
      ],
    },
    { level: 0 }
  );
  const parsedDataHash = computeDatasetHash({
    dataMode: draft.source.dataMode,
    rows: draft.dataset.rows,
    seed: draft.dataset.seed,
    recipe: draft.dataset.recipe,
  });
  const caseId = computeCaseId({
    specVersion: 1,
    generatorVersion: draft.generatorVersion,
    schemaHash: sha256Hex(canonicalJson(readTeaArchive(tea).structure)),
    datasetHash: parsedDataHash,
    workload: draft.workload,
    oracle: draft.oracle,
  });
  const manifest: BenchCaseManifest = parseBenchCaseManifest({
    ...draft,
    caseId,
    dataset: { ...draft.dataset, dataHash: parsedDataHash },
  });
  await mkdir(dir, { recursive: true });
  await writeFile(teaPath, tea);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const covering = generateCoveringArray({
    dimensions: [
      { name: 'scenarioId', values: [scenario.scenarioId] },
      { name: 'ruleId', values: [scenario.ruleId] },
    ],
    maxRows: 1,
  });
  return {
    cases: [{ caseId, dir, manifestPath, teaPath }],
    coverage: {
      totalPairs: covering.receipt.completable,
      coveredPairs: covering.receipt.covered,
      uncoveredPairs: covering.uncoveredPairs,
      receipt: covering.receipt,
    },
  };
}
