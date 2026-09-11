import { Worker } from "node:worker_threads";
import { roundMetric } from "./metrics";

export interface PollStormRequest {
  url: string;
  headers?: Record<string, string>;
  // Independent pollers, each keeping one request in flight — the shape a
  // table open in N browser tabs produces.
  viewers: number;
  rounds: number;
  thinkTimeMs: number;
  // Hard stop so a slow server cannot turn a bounded case into an unbounded
  // one; whatever completed by then is still reported.
  budgetMs: number;
}

export interface PollStormSample {
  viewer: number;
  round: number;
  durationMs: number;
  status: number;
  error?: string;
}

export interface PollStormResult {
  wallMs: number;
  samples: PollStormSample[];
}

export const runPollStorm = (
  request: PollStormRequest,
): Promise<PollStormResult> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./poll-storm.worker.mjs", import.meta.url),
      {
        workerData: {
          url: request.url,
          headers: request.headers ?? {},
          viewers: request.viewers,
          rounds: request.rounds,
          thinkTimeMs: request.thinkTimeMs,
          stopAt: request.budgetMs,
        },
      },
    );
    let settled = false;
    worker.once("message", (message) => {
      settled = true;
      void worker.terminate();
      if (message.ok === true) resolve(message.result as PollStormResult);
      else reject(new Error(message.error));
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) {
        reject(
          new Error(`Poll storm worker exited before reporting (code ${code})`),
        );
      }
    });
  });

const percentile = (sorted: number[], fraction: number) => {
  if (!sorted.length) return 0;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(fraction * sorted.length) - 1),
  );
  return sorted[index]!;
};

export const summarizePollStorm = (result: PollStormResult) => {
  const ok = result.samples.filter((sample) => sample.status === 200);
  const durations = ok.map((sample) => sample.durationMs).sort((a, b) => a - b);
  return {
    pollCount: result.samples.length,
    okCount: ok.length,
    errorCount: result.samples.length - ok.length,
    pollWallMs: roundMetric(result.wallMs),
    // Completed polls per second across every viewer: the number a coalescer
    // that removes per-poll server work should move, if it moves anything a
    // client can see.
    pollThroughputPerSec: roundMetric(
      result.wallMs > 0 ? (ok.length / result.wallMs) * 1000 : 0,
    ),
    pollP50Ms: roundMetric(percentile(durations, 0.5)),
    pollP95Ms: roundMetric(percentile(durations, 0.95)),
    pollP99Ms: roundMetric(percentile(durations, 0.99)),
    pollMaxMs: roundMetric(
      durations.length ? durations[durations.length - 1]! : 0,
    ),
  };
};
