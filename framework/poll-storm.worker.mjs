import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

// N viewers polling one endpoint, off the main thread.
//
// The perf harness boots the Nest app in this process, so a poller running on
// the main thread would be competing with the server it is timing for the same
// event loop, and the latencies would partly be measurements of the harness.
// Each viewer keeps one request in flight at a time, which is what a browser
// tab does; concurrency comes from there being many of them.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const pollOnce = async (url, headers) => {
  const startedAt = performance.now();
  const response = await fetch(url, { method: "GET", headers });
  // Drain the body: a latency that stops at the headers is not the latency the
  // viewer experienced.
  await response.text();
  return { durationMs: performance.now() - startedAt, status: response.status };
};

const runViewer = async (viewer) => {
  const { url, headers, rounds, thinkTimeMs, stopAt } = workerData;
  const samples = [];
  for (let round = 0; round < rounds; round += 1) {
    if (stopAt && performance.now() > stopAt) break;
    try {
      const result = await pollOnce(url, headers);
      samples.push({ viewer, round, ...result });
    } catch (error) {
      samples.push({
        viewer,
        round,
        durationMs: -1,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (thinkTimeMs > 0) await sleep(thinkTimeMs);
  }
  return samples;
};

try {
  // A common start line, so viewer 0 is not already several rounds ahead by
  // the time the last viewer sends its first request.
  const startedAt = performance.now();
  const perViewer = await Promise.all(
    Array.from({ length: workerData.viewers }, (_, index) => runViewer(index)),
  );
  parentPort?.postMessage({
    ok: true,
    result: {
      wallMs: performance.now() - startedAt,
      samples: perViewer.flat(),
    },
  });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.stack || error.message : String(error),
  });
}
