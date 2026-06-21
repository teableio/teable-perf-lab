// Readiness polling for the perf runners.
//
// Almost every seed/execute path has to wait for an asynchronous backend state
// to settle — a computed field to backfill, a lookup to recompute, a full scan
// to reach the expected row count — before it can measure or verify. The shape
// is always the same: call an assertion that throws until the state is ready,
// retry on a fixed interval, and give up loudly after a timeout. Each runner
// used to inline that loop (and its own copy of `sleep`); this module owns it
// once so the timeout policy and the give-up error are uniform.
//
// `pollUntilReady` is deliberately config-agnostic: the caller resolves its own
// timeout and interval (some read `config.verify`, some `config.ready`, some
// hard-code them) and passes plain numbers. The assertion is a zero-arg thunk,
// so a caller that needs an attempt counter keeps it in its own closure.

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const pollUntilReady = async <T>(
  options: { timeoutMs: number; pollIntervalMs: number; description: string },
  assertFn: () => Promise<T>,
): Promise<T> => {
  const { timeoutMs, pollIntervalMs, description } = options;
  const startedAt = Date.now();
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      return await assertFn();
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }

  throw new Error(
    `Timed out waiting for ${description} after ${timeoutMs}ms: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
};
