// The perf-artifact filename contract.
//
// The writer (framework/artifacts.ts) and the reader
// (scripts/perf-artifact-read-model.mjs) each carried their own byte-identical
// copy of these four functions under two different export names. If either copy
// had changed alone, execute jobs would have written artifacts the report job
// could not find — and nothing would have failed until a full run's report
// stage came up empty.
//
// Plain JavaScript so both the TypeScript framework and the `.mjs` report
// scripts can import it, the same reason atomic-file.js and sleep.js are.

export const sanitizeCaseId = (caseId) =>
  caseId.replace(/[^a-zA-Z0-9_.-]+/g, "-");

export const sanitizeSegment = (value) =>
  value.replace(/[^a-zA-Z0-9_.-]+/g, "-");

export const getArtifactJsonName = (caseId, engine) =>
  `${sanitizeCaseId(caseId)}-${sanitizeSegment(engine)}.json`;

export const getSummaryMarkdownName = (caseId, engine) =>
  `summary-${sanitizeCaseId(caseId)}-${sanitizeSegment(engine)}.md`;
