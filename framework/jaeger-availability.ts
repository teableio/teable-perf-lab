// Preflight reachability check for the shared Jaeger service.
//
// ---------------------------------------------------------------------------
// TEMPORARY MEASURE — added 2026-07-31, while `teable-perf-jaeger` on the
// `observability-stack` VM is deliberately shut down.
//
// Why it exists: the execute jobs already degraded gracefully when Jaeger was
// unreachable — trace-fetch-control.ts opens a `hard-outage` breaker, the perf
// numbers still get reported, and the run summary shows the
// "Trace 服务不可用" card. The report job's publish step had no such path:
// `postTrace` threw on the very first trace and
// `.github/workflows/teable-ee-e2e-perf.yml` turned that into a full-run
// failure. That asymmetry is what kept the suite red for ~30 hours across 11
// consecutive runs (first failure 2026-07-30T05:41Z) while the perf results
// themselves were perfectly good.
//
// What it does: probe Jaeger once before publishing. Unreachable means the
// trace *viewer* is down, not that the run regressed — so skip publication,
// reconcile the manifests into `hard-outage`, and let the run be judged on its
// perf results. The raw trace evidence is unaffected either way: the execute
// jobs spool it to GitHub artifacts and never touch shared Jaeger.
//
// What is deliberately NOT softened: a Jaeger that answers the probe but then
// loses traces still fails the run, because that is a real trace-capture
// regression rather than an infrastructure outage.
//
// WHEN JAEGER COMES BACK: the probe itself should stay — it is the behaviour
// the publish path was missing. What should be revisited is
// `isTraceServiceUnavailableError` below, which duplicates the private copy in
// framework/trace-collector.ts. It was not consolidated because
// scripts/check-trace-collector-exporter-outage.mjs hand-stages the collector's
// imports by string-replacing every module specifier, so giving the collector a
// new dependency means rewriting that check in the same breath. Merging the two
// into this module is the follow-up.
// ---------------------------------------------------------------------------

/**
 * Connection-level failures mean the trace service is unreachable. A reachable
 * service that answers with an HTTP status is a different thing entirely and
 * must not be classified as an outage.
 *
 * Keep in sync with the private copy in framework/trace-collector.ts.
 */
export const isTraceServiceUnavailableError = (error?: string) =>
  error != null &&
  /\b(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|connect timeout|fetch failed|socket hang up/i.test(
    error,
  );

/**
 * `fetch` rejects with a bare "fetch failed" and hides the real errno on
 * `error.cause`. Eleven consecutive red runs recorded nothing but "fetch
 * failed", which is precisely why the cause was never identifiable from CI
 * logs — always unwrap it.
 */
export const describeFetchError = (error: unknown): string => {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as { code?: unknown }).code;
    const detail =
      typeof code === "string" && code.length > 0 ? code : cause.message;
    return detail && detail !== error.message
      ? `${error.message} (${detail})`
      : error.message;
  }
  return error.message;
};

export type JaegerAvailability =
  | { available: true }
  | { available: false; error: string };

/**
 * Ask Jaeger for its service list. Anything that speaks HTTP counts as
 * available — including 4xx, which means something is answering and a publish
 * failure would be a real problem worth failing on. Only connection-level
 * errors and 5xx (the service is up but broken) count as an outage.
 *
 * Probes more than once so a single blip cannot silently disable publication.
 *
 * Takes its `fetch` as a parameter rather than importing the seam in
 * framework/jaeger-transport.ts: this module is loaded by a plain-Node script
 * under `--experimental-strip-types`, which needs explicit file extensions,
 * while tsc rejects a `.ts` extension on an import. Callers that want the seam
 * pass `jaegerFetch` in.
 */
export const probeJaegerAvailability = async ({
  jaegerApiBaseUrl,
  fetchImpl = fetch,
  timeoutMs = 5_000,
  attempts = 2,
  retryDelayMs = 500,
  sleep = (ms: number) => new Promise((done) => setTimeout(done, ms)),
}: {
  jaegerApiBaseUrl: string;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
  timeoutMs?: number;
  attempts?: number;
  retryDelayMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
}): Promise<JaegerAvailability> => {
  const url = `${jaegerApiBaseUrl.replace(/\/+$/, "")}/api/services`;
  let lastError = "";
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status < 500) {
        return { available: true };
      }
      lastError = `Jaeger API returned ${response.status}`;
    } catch (error) {
      lastError = describeFetchError(error);
    }
    if (attempt < attempts) {
      await sleep(retryDelayMs);
    }
  }
  return { available: false, error: lastError || "Jaeger probe failed" };
};
