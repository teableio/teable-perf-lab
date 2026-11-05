import { Options } from '@effect/cli';
import { Option } from 'effect';

export const specOption = Options.text('spec').pipe(
  Options.withDescription('Generator specification JSON path')
);
export const outOption = Options.text('out').pipe(Options.withDescription('Output path'));

export const teaOption = Options.text('tea').pipe(
  Options.withDescription('Teable archive path'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const requiredTeaOption = Options.text('tea').pipe(
  Options.withDescription('Teable archive path')
);
export const caseOption = Options.text('case').pipe(
  Options.withDescription('Benchmark case manifest path')
);
export const backendOption = Options.choice('backend', ['pglite', 'postgres']).pipe(
  Options.withDescription('Runtime database backend'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const connectionOption = Options.text('connection').pipe(
  Options.withDescription('PostgreSQL connection string'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const samplesOption = Options.integer('samples').pipe(
  Options.withDescription('Measured samples per operation'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const warmupOption = Options.integer('warmup').pipe(
  Options.withDescription('Warmup samples per operation'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const repetitionsOption = Options.integer('repetitions').pipe(
  Options.withDescription('Fresh benchmark repetitions'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const evidenceOption = Options.text('evidence').pipe(
  Options.withDescription('Evidence JSON output path'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const evidenceInputOption = Options.text('evidence-input').pipe(
  Options.withDescription(
    'Optional catalogue scope and planned suite receipts; factual provenance is captured automatically'
  ),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const impactOption = Options.text('impact').pipe(
  Options.withDescription(
    'Optional tea-bench-impact-graph/1 JSON output path; requires --evidence'
  ),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const impactInputOption = Options.text('impact').pipe(
  Options.withDescription('Optional tea-bench-impact-graph/1 JSON input path'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const baselineOption = Options.text('baseline').pipe(
  Options.withDescription('Baseline run report path')
);
export const candidateOption = Options.text('candidate').pipe(
  Options.withDescription('Candidate run report path')
);
export const runOption = Options.text('run').pipe(
  Options.withDescription('Benchmark run report path')
);
export const maxCasesOption = Options.integer('max-cases').pipe(
  Options.withDescription('Maximum generated cases'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const maxRowsOption = Options.integer('max-rows').pipe(
  Options.withDescription('Maximum rows per generated case'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const inputOption = Options.text('input').pipe(Options.withDescription('Input JSON path'));
export const markdownOption = Options.text('markdown').pipe(
  Options.withDescription('Chinese Markdown output path')
);
export const scenarioOption = Options.text('scenario').pipe(
  Options.withDescription('Exact stable catalogue scenario ID')
);
export const maxSearchStatesOption = Options.integer('max-search-states').pipe(
  Options.withDescription('Maximum catalogue search states'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
export const maxMillisOption = Options.integer('max-millis').pipe(
  Options.withDescription('Maximum catalogue search time in milliseconds'),
  Options.optional,
  Options.map(Option.getOrUndefined)
);
