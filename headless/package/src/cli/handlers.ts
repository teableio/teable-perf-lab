import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { sha256Hex } from '../case/canonicalJson';
import { parseBenchCaseManifest } from '../case/manifest';
import {
  enumerateScenarioCatalogue,
  materializeCatalogueScenario,
  renderCatalogueMarkdown,
  ScenarioCatalogueSchema,
} from '../catalogue';
import { BenchError } from '../errors';
import { captureInvocation, capturedEvidenceInput, type EvidencePlan } from '../evidence/capture';
import { serializeBenchEvidence } from '../evidence/serialize';
import { deriveCases } from '../generator/deriveFromSchema';
import type { GeneratorSpec } from '../generator/generate';
import { generateCases } from '../generator/generate';
import { buildTeaBenchImpactGraph } from '../impact/build';
import { exportTeaBenchImpactRows } from '../impact/rows';
import { exportTeaBenchReportRows } from '../report/exportTeable';
import { renderTeaBenchReportHtml } from '../report/renderHtml';
import { renderTeaBenchReportMarkdown } from '../report/renderMarkdown';
import { parseTeaBenchReport, type TeaBenchReport } from '../report/schema';
import { deriveDeclaredBusinessTopology, type DeclaredBusinessTopology } from '../report/topology';
import { runCase } from '../runner/BenchRunner';
import type { BenchRunReport } from '../runner/BenchRunner';
import { compareReports } from '../runner/compare';
import { readTeaArchive } from '../tea/teaZip';
import { readJson, writeJson } from './io';
import type { BenchCliHandlers } from './types';

const loadRunReport = async (path: string): Promise<BenchRunReport> =>
  (await readJson(path)) as BenchRunReport;

export async function loadDeclaredBusinessTopology(
  report: TeaBenchReport
): Promise<DeclaredBusinessTopology | undefined> {
  const input = report.provenance.reproducibility.inputs.find(({ path }) =>
    path.toLowerCase().endsWith('.tea')
  );
  if (!input) return undefined;

  const teaPath = resolve(input.path);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(teaPath);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
    throw error;
  }
  if (sha256Hex(bytes) !== input.sha256) return undefined;

  return deriveDeclaredBusinessTopology(readTeaArchive(bytes).structure);
}

export const defaultHandlers: BenchCliHandlers = {
  async generate(input) {
    const rawSpec = await readJson(input.specPath);
    if (rawSpec === null || typeof rawSpec !== 'object' || Array.isArray(rawSpec)) {
      throw new BenchError('bench.cli.argument_invalid', 'Generator spec must be an object');
    }
    return generateCases({
      ...(rawSpec as GeneratorSpec),
      outDir: input.outDir,
    });
  },

  async derive(input) {
    return deriveCases({
      teaPath: input.teaPath,
      outDir: input.outDir,
      limits:
        input.maxCases === undefined && input.maxRows === undefined
          ? undefined
          : { maxCases: input.maxCases, maxRows: input.maxRows },
    });
  },

  async run(input) {
    const manifestPath = input.casePath;
    if (input.evidencePath === undefined && input.evidenceInputPath !== undefined) {
      throw new BenchError('bench.cli.argument_invalid', '--evidence-input requires --evidence');
    }
    const evidencePlan =
      input.evidenceInputPath === undefined
        ? undefined
        : ((await readJson(input.evidenceInputPath)) as EvidencePlan);
    const manifest = parseBenchCaseManifest(await readJson(manifestPath));
    const teaPath = resolve(dirname(manifestPath), input.tea ?? manifest.source.tea);
    const backend = input.backend ?? manifest.run.backend;
    const connectionString =
      backend === 'postgres'
        ? (input.connection ?? process.env.TEABLE_BENCH_CONNECTION)
        : undefined;
    const captured =
      input.evidencePath === undefined
        ? undefined
        : await captureInvocation(manifestPath, teaPath, manifest.source.dataMode);
    const report = await runCase({
      teaPath,
      manifestPath,
      backendOverride: backend,
      connectionString,
      samples: input.samples,
      warmup: input.warmup,
      repetitions: input.repetitions,
    });
    await writeJson(input.outPath, report);
    if (input.evidencePath !== undefined && captured !== undefined) {
      const evidenceInput = capturedEvidenceInput({
        run: report,
        manifest,
        captured,
        plan: evidencePlan,
        outPath: input.outPath,
      });
      const evidenceReport = serializeBenchEvidence(report, evidenceInput);
      await writeJson(input.evidencePath, evidenceReport);
      if (input.impactPath !== undefined) {
        const archive = readTeaArchive(await readFile(teaPath));
        const impact = buildTeaBenchImpactGraph({
          report: evidenceReport,
          run: report,
          manifest,
          structure: archive.structure,
        });
        await writeJson(input.impactPath, impact);
        await writeJson(`${input.impactPath}.rows.json`, exportTeaBenchImpactRows(impact));
      }
    }
    return report;
  },

  async compare(input) {
    const report = compareReports({
      baseline: await loadRunReport(input.baselinePath),
      candidate: await loadRunReport(input.candidatePath),
    });
    await writeJson(input.outPath, report);
    return report;
  },

  async verify(input) {
    return loadRunReport(input.runPath);
  },

  async catalogueEnumerate(input) {
    const catalogue = ScenarioCatalogueSchema.parse(
      enumerateScenarioCatalogue({
        maxCases: input.maxCases,
        maxSearchStates: input.maxSearchStates,
        maxMillis: input.maxMillis,
      })
    );
    const familyCounts: Record<string, number> = {};
    for (const scenario of catalogue.scenarios) {
      familyCounts[scenario.family] = (familyCounts[scenario.family] ?? 0) + 1;
    }
    const sortedFamilyCounts = Object.fromEntries(
      Object.entries(familyCounts).sort(([left], [right]) => left.localeCompare(right))
    );
    await writeJson(input.outPath, catalogue);
    await writeFile(input.markdownPath, renderCatalogueMarkdown(catalogue), 'utf8');
    return { catalogue, familyCounts: sortedFamilyCounts };
  },

  async catalogueMaterialize(input) {
    const catalogue = enumerateScenarioCatalogue();
    const scenario = catalogue.scenarios.find((item) => item.scenarioId === input.scenarioId);
    if (!scenario) {
      throw new BenchError(
        'bench.catalogue.scenario_unknown',
        `Unknown exact scenario ID: ${input.scenarioId}`
      );
    }
    const result = await materializeCatalogueScenario({ scenario, outDir: input.outDir });
    return { ...result, scenarioId: scenario.scenarioId, ruleId: scenario.ruleId };
  },

  async reportRender(input) {
    const report = parseTeaBenchReport(await readJson(input.inputPath));
    await writeFile(input.outPath, renderTeaBenchReportMarkdown(report), 'utf8');
    return { report };
  },

  async reportRenderHtml(input) {
    const report = parseTeaBenchReport(await readJson(input.inputPath));
    const impact = input.impactPath === undefined ? undefined : await readJson(input.impactPath);
    const topology = await loadDeclaredBusinessTopology(report);
    await writeFile(input.outPath, renderTeaBenchReportHtml(report, impact, topology), 'utf8');
    return { report };
  },

  async reportExportTeable(input) {
    const report = parseTeaBenchReport(await readJson(input.inputPath));
    const rows = exportTeaBenchReportRows(report);
    await writeJson(input.outPath, rows);
    return { report, rows };
  },
};
