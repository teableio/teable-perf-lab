import assert from "node:assert/strict";
import { createServer } from "node:http";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { runIsolatedJsonRequest } from "./isolated-json-request.ts";

test("measures response parsing outside the server event loop", async (t) => {
  const busyMs = 400;
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.once("finish", () => {
      const busyUntil = performance.now() + busyMs;
      while (performance.now() < busyUntil) {
        // Model CPU-heavy after-response projections on the Nest/Vitest thread.
      }
    });
    response.end(JSON.stringify([{ id: "rec1" }]));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert(address && typeof address === "object");
  const startedAt = performance.now();
  const result = await runIsolatedJsonRequest({
    url: `http://127.0.0.1:${address.port}`,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: { ok: true },
    responseMode: "recordIds",
  });
  const parentElapsedMs = performance.now() - startedAt;

  assert.equal(result.status, 200);
  assert.deepEqual(result.recordIds, ["rec1"]);
  assert(
    parentElapsedMs - result.durationMs > busyMs / 2,
    `expected worker timing to exclude main-thread contention; worker=${result.durationMs}ms parent=${parentElapsedMs}ms`,
  );
});
