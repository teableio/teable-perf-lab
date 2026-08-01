// The published trace viewer's URL contract.
//
// Two writers need it: framework/artifacts.ts stamps the link into each case's
// summary markdown while the case is still running, and
// scripts/perf-artifact-read-model.mjs builds the `Trace URL` the Teable row
// carries. scripts/publish-trace-pages.mjs writes the files they point at. If
// any of them disagreed about the shape, the link would 404 and nothing would
// notice until someone clicked it.
//
// Plain JavaScript so the TypeScript framework and the `.mjs` report scripts can
// both import it, the same reason artifact-names.js and atomic-file.js are.

// A trace only lives on the site under the run that published it, so both parts
// are required: a run-less link would point at a path that never exists.
export const buildTraceViewUrl = (traceId, runId, baseUrl) => {
  if (!baseUrl || !traceId || !runId) {
    return "";
  }
  return `${baseUrl.replace(/\/+$/, "")}/trace.html?run=${encodeURIComponent(
    runId,
  )}&trace=${encodeURIComponent(traceId)}`;
};
