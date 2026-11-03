import type { ScenarioCatalogue } from '../catalogue';
import type { DerivedCasesResult } from '../generator/deriveFromSchema';
import type { GeneratedCase, GeneratorCoverage } from '../generator/generate';
import type { TeableReportRows } from '../report/exportTeable';
import type { TeaBenchReport } from '../report/schema';
import type { BenchRunReport } from '../runner/BenchRunner';
import type { BenchCompareReport } from '../runner/compare';

export type BenchCliIo = {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
};

export type GenerateInput = {
  readonly specPath: string;
  readonly outDir: string;
};

export type DeriveInput = {
  readonly teaPath: string;
  readonly outDir: string;
  readonly maxCases?: number;
  readonly maxRows?: number;
};

export type RunInput = {
  readonly casePath: string;
  readonly tea?: string;
  readonly backend?: 'pglite' | 'postgres';
  readonly connection?: string;
  readonly samples?: number;
  readonly warmup?: number;
  readonly repetitions?: number;
  readonly outPath: string;
  readonly evidencePath?: string;
  readonly evidenceInputPath?: string;
  readonly impactPath?: string;
};

export type CompareInput = {
  readonly baselinePath: string;
  readonly candidatePath: string;
  readonly outPath: string;
};

export type VerifyInput = {
  readonly runPath: string;
};

export type CatalogueEnumerateInput = {
  readonly outPath: string;
  readonly markdownPath: string;
  readonly maxCases?: number;
  readonly maxSearchStates?: number;
  readonly maxMillis?: number;
};

export type CatalogueEnumerateResult = {
  readonly catalogue: ScenarioCatalogue;
  readonly familyCounts: Readonly<Record<string, number>>;
};

export type CatalogueMaterializeInput = {
  readonly scenarioId: string;
  readonly outDir: string;
};

export type CatalogueMaterializeResult = GenerateResult & {
  readonly scenarioId: string;
  readonly ruleId: string;
};

export type ReportRenderInput = {
  readonly inputPath: string;
  readonly outPath: string;
  readonly impactPath?: string;
};

export type ReportRenderResult = {
  readonly report: TeaBenchReport;
};

export type ReportExportTeableInput = {
  readonly inputPath: string;
  readonly outPath: string;
};

export type ReportExportTeableResult = {
  readonly report: TeaBenchReport;
  readonly rows: TeableReportRows;
};

export type GenerateResult = {
  readonly cases: ReadonlyArray<GeneratedCase>;
  readonly coverage: GeneratorCoverage;
};

export type DeriveResult = DerivedCasesResult;

export type BenchCliHandlers = {
  readonly generate: (input: GenerateInput) => Promise<GenerateResult>;
  readonly derive: (input: DeriveInput) => Promise<DeriveResult>;
  readonly run: (input: RunInput) => Promise<BenchRunReport>;
  readonly compare: (input: CompareInput) => Promise<BenchCompareReport>;
  readonly verify: (input: VerifyInput) => Promise<BenchRunReport>;
  readonly catalogueEnumerate: (
    input: CatalogueEnumerateInput
  ) => Promise<CatalogueEnumerateResult>;
  readonly catalogueMaterialize: (
    input: CatalogueMaterializeInput
  ) => Promise<CatalogueMaterializeResult>;
  readonly reportRender: (input: ReportRenderInput) => Promise<ReportRenderResult>;
  readonly reportRenderHtml: (input: ReportRenderInput) => Promise<ReportRenderResult>;
  readonly reportExportTeable: (
    input: ReportExportTeableInput
  ) => Promise<ReportExportTeableResult>;
};
