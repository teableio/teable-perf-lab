import { axios } from "@teable/openapi";
import { PerfRunDiagnosticError } from "./types";

// Standardized, opt-in "is the server still responding?" watchdog.
//
// A case opts in by setting `watchdogMs` in its `.case.ts` (see PerfCase). When
// set, runPerfCase runs the case under an *idle* watchdog: a timer trips only if
// no HTTP request or SSE event has made progress for `watchdogMs`. A healthy
// case keeps issuing requests / receiving stream events, so the timer keeps
// resetting and never trips; a case stuck on a hung server goes silent, trips
// the timer, and fails fast with a clear diagnostic instead of hanging until the
// hard `timeoutMs` (e.g. 600s). On trip we also abort the case AbortSignal so
// signal-aware requests (every SSE stream via perfStreamSse, plus runners that
// forward `context.signal`) are cancelled, letting the app close cleanly.
//
// This is intentionally idle-based, not total-elapsed-based, so it does not need
// per-case tuning against a healthy run's duration: only true silence trips it.
// Set `watchdogMs` comfortably above the longest single server round-trip the
// case expects (a healthy paged scan, stream gap, or bulk request).

let lastActivityAt = Date.now();
let requestProbeId: number | undefined;
let responseProbeId: number | undefined;
let probeInstalled = false;

/** Record that the server just made progress (request sent or response/event received). */
export const pokeWatchdogActivity = () => {
  lastActivityAt = Date.now();
};

// Axios request/response interceptors that feed the activity signal. Installed
// alongside the trace collector and re-installed whenever interceptors are reset
// between engines. Poking is a cheap timestamp write and harmless when no
// watchdog is currently running.
export const installWatchdogActivityProbe = () => {
  if (probeInstalled) {
    return;
  }
  probeInstalled = true;

  requestProbeId = axios.interceptors.request.use((config) => {
    pokeWatchdogActivity();
    return config;
  });
  responseProbeId = axios.interceptors.response.use(
    (response) => {
      pokeWatchdogActivity();
      return response;
    },
    (error) => {
      pokeWatchdogActivity();
      return Promise.reject(error);
    },
  );
};

export const uninstallWatchdogActivityProbe = () => {
  if (!probeInstalled) {
    return;
  }
  if (requestProbeId != null) {
    axios.interceptors.request.eject(requestProbeId);
  }
  if (responseProbeId != null) {
    axios.interceptors.response.eject(responseProbeId);
  }
  requestProbeId = undefined;
  responseProbeId = undefined;
  probeInstalled = false;
};

/**
 * Run `fn` under the idle watchdog. `onAbort` receives the AbortSignal so the
 * caller can publish it (e.g. onto the run context) before `fn` starts issuing
 * requests. If the watchdog trips, the signal is aborted and a
 * PerfRunDiagnosticError is thrown so runPerfCase records a fail artifact.
 */
export const runWithWatchdog = async <T>(
  {
    watchdogMs,
    onAbort,
  }: {
    watchdogMs: number;
    onAbort: (signal: AbortSignal) => void;
  },
  fn: () => Promise<T>,
): Promise<T> => {
  const controller = new AbortController();
  onAbort(controller.signal);
  pokeWatchdogActivity();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = false;

  const watchdog = new Promise<never>((_, reject) => {
    const schedule = (delayMs: number) => {
      timer = setTimeout(() => {
        if (settled) {
          return;
        }
        const idleMs = Date.now() - lastActivityAt;
        if (idleMs >= watchdogMs) {
          const message =
            `perf watchdog: no server activity for ${idleMs}ms ` +
            `(limit ${watchdogMs}ms); the server likely hung. Failing fast ` +
            `instead of waiting for the case timeout.`;
          controller.abort(new Error(message));
          reject(
            new PerfRunDiagnosticError(message, {
              metrics: {},
              thresholds: [],
              details: { watchdog: { trippedMs: idleMs, watchdogMs } },
            }),
          );
          return;
        }
        // Not idle long enough yet; re-check once the remaining window elapses.
        schedule(watchdogMs - idleMs);
      }, delayMs);
    };
    schedule(watchdogMs);
  });

  const work = fn();
  // When the watchdog wins the race, `work` stays pending until the aborted
  // signal rejects its in-flight request; attach a no-op catch so that late
  // rejection is not surfaced as an unhandled rejection.
  work.catch(() => {});

  try {
    return await Promise.race([work, watchdog]);
  } finally {
    settled = true;
    if (timer) {
      clearTimeout(timer);
    }
  }
};
