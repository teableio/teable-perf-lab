import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import test, { beforeEach } from "node:test";
import ts from "typescript";

// Perf-lab runs without the host application's dependency tree. These strict
// boundary doubles validate the snapshot/event fields consumed by the real
// helper; they do not pretend to exercise OpenAPI's Zod implementation.
const uuidPattern =
  /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const terminalStatuses = ["cancelled", "succeeded", "partial", "failed"];
const parseSnapshot = (raw) => {
  assert.ok(raw && typeof raw === "object", "snapshot must be an object");
  assert.match(raw.operationId, uuidPattern);
  assert.equal(typeof raw.tableId, "string");
  assert.ok(
    ["preparing", "running", "cancelling", ...terminalStatuses].includes(
      raw.status,
    ),
    "invalid snapshot status",
  );
  assert.ok(["pending", "settled", "failed"].includes(raw.effectsStatus));
  for (const key of [
    "totalCount",
    "processedCount",
    "deletedCount",
    "failedCount",
    "revision",
    "pendingEffectCount",
    "failedEffectCount",
  ]) {
    assert.ok(Number.isInteger(raw[key]) && raw[key] >= 0, `invalid ${key}`);
  }
  assert.equal(typeof raw.recoverable, "boolean");
  if (raw.error !== undefined) {
    assert.equal(typeof raw.error.message, "string");
    assert.ok(raw.error.message.length <= 2048);
    if (raw.error.code !== undefined) {
      assert.equal(typeof raw.error.code, "string");
      assert.ok(raw.error.code.length <= 128);
    }
  }
  const { id: _eventId, ...snapshot } = raw;
  return snapshot;
};
const parseEvent = (raw) => {
  assert.ok(["progress", "done"].includes(raw.id), "invalid event id");
  return { ...parseSnapshot(raw), id: raw.id };
};

const moduleSources = {
  "mock:delete-openapi": `
    export const X_CANARY_HEADER = "x-teable-canary";
    export const axios = {
      defaults: {
        baseURL: "https://perf.invalid/api",
        headers: { common: { Authorization: "Bearer fixture", ignored: 123 } },
      },
      getUri: ({ baseURL, url }) => baseURL + url,
      post: (...args) => globalThis.__deleteOperationTest.post(...args),
      get: (...args) => globalThis.__deleteOperationTest.get(...args),
    };
    export const deleteSelectionOperationSnapshotSchema = {
      parse: (raw) => globalThis.__deleteOperationTest.parseSnapshot(raw),
    };
    export const deleteSelectionOperationEventSchema = {
      parse: (raw) => globalThis.__deleteOperationTest.parseEvent(raw),
    };
    export const isDeleteSelectionOperationTerminal = (snapshot) =>
      ["cancelled", "succeeded", "partial", "failed"].includes(snapshot.status);
    export const restoreTrash = () => globalThis.__deleteOperationTest.unexpected("restoreTrash");
  `,
  "mock:delete-trace": `
    export const buildPerfTraceHeaders = () => ({ traceparent: "observer-trace" });
    export const recordPerfTraceRefFromHeaders = (ref) => globalThis.__deleteOperationTest.traceRefs.push(ref);
    export const withPerfTraceStep = async (_context, _case, step, fn) => {
      globalThis.__deleteOperationTest.traceSteps.push(step);
      return fn();
    };
  `,
  "mock:delete-watchdog": `
    export const pokeWatchdogActivity = () => globalThis.__deleteOperationTest.watchdogPokes++;
  `,
  "mock:delete-runner-dependencies": `
    const unexpected = (name) => () => globalThis.__deleteOperationTest.unexpected(name);
    export const permanentDeleteTable = unexpected("permanentDeleteTable");
    export const isExecuteDbIsolated = unexpected("isExecuteDbIsolated");
    export const measureAsync = unexpected("measureAsync");
    export const pollUntilReady = unexpected("pollUntilReady");
    export class PerfRunDiagnosticError extends Error {}
    export const runRecordMutationLifecycle = unexpected("runRecordMutationLifecycle");
    export const seedRecordMutationLifecycle = unexpected("seedRecordMutationLifecycle");
    export const assertDeleted = unexpected("assertDeleted");
    export const assertRowsRestored = unexpected("assertRowsRestored");
    export const buildRecordReplayResult = unexpected("buildRecordReplayResult");
    export const prepareRecordReplayFixture = unexpected("prepareRecordReplayFixture");
    export const waitForRowsRestored = unexpected("waitForRowsRestored");
    export const cleanupDeletedRecordSeed = unexpected("cleanupDeletedRecordSeed");
    export const resolveRecordTrashCleanupPolling = unexpected("resolveRecordTrashCleanupPolling");
    export const findRecordTrashItems = unexpected("findRecordTrashItems");
  `,
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    let mockUrl;
    if (specifier === "@teable/openapi") mockUrl = "mock:delete-openapi";
    else if (specifier === "../trace-collector") mockUrl = "mock:delete-trace";
    else if (specifier === "../watchdog") mockUrl = "mock:delete-watchdog";
    else if (
      context.parentURL?.endsWith("/record-delete-stream.runner.ts") &&
      specifier !== "./record-delete-operation"
    )
      mockUrl = "mock:delete-runner-dependencies";
    if (mockUrl) return { url: mockUrl, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !extname(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (moduleSources[url]) {
      return {
        format: "module",
        shortCircuit: true,
        source: moduleSources[url],
      };
    }
    if (!url.endsWith(".ts")) return nextLoad(url, context);
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: fileURLToPath(url),
      }).outputText,
    };
  },
});

const {
  assertDeleteOperationReady,
  deleteAllRowsDurably,
  DeleteOperationObservationError,
  DELETE_OPERATION_TIMING_PROFILE,
} = await import("./record-delete-operation.ts");
const { runRecordDeleteStreamCase } = await import(
  "./record-delete-stream.runner.ts"
);

const tableId = "tbl-delete-fixture";
const perfCase = {
  id: "record-delete-stream/test",
  kind: "record-delete-stream",
};
let state;
const snapshot = (overrides = {}) => ({
  operationId: state.operationId,
  tableId,
  status: "succeeded",
  totalCount: 3,
  processedCount: 3,
  deletedCount: 3,
  failedCount: 0,
  revision: 3,
  effectsStatus: "settled",
  pendingEffectCount: 0,
  failedEffectCount: 0,
  recoverable: false,
  ...overrides,
});
const running = (overrides = {}) =>
  snapshot({
    status: "running",
    processedCount: 0,
    deletedCount: 0,
    revision: 1,
    ...overrides,
  });
const frame = (data) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const event = (overrides = {}) => snapshot({ id: "done", ...overrides });
const invoke = (overrides = {}) =>
  deleteAllRowsDurably({
    tableId,
    viewId: "viw-delete-fixture",
    expectedCount: 3,
    stepId: "deleteAll",
    perfCase,
    context: { engine: "v2", cookie: "session=fixture" },
    windowId: "window-fixture",
    timeoutMs: 1000,
    ...overrides,
  });
const streamResponse = (text, status = 200) => {
  const bytes = new TextEncoder().encode(text);
  // Deliberately split the SSE prefix, JSON tokens and UTF-8 code points.
  const chunks = [];
  for (let start = 0; start < bytes.length; start += 7) {
    chunks.push(bytes.slice(start, start + 7));
  }
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
      cancel() {
        state.cancelledStreams++;
      },
    }),
    { status, headers: { "content-type": "text/event-stream" } },
  );
};
const rejected = async (promise, pattern, expectedSnapshot) => {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof DeleteOperationObservationError);
    assert.match(error.message, pattern);
    if (expectedSnapshot) assert.deepEqual(error.snapshot, expectedSnapshot);
    return true;
  });
  assert.equal(
    state.requests.filter(({ method }) => method === "POST").length,
    1,
  );
};

beforeEach((t) => {
  state = {
    requests: [],
    traceSteps: [],
    traceRefs: [],
    watchdogPokes: 0,
    cancelledStreams: 0,
    unexpectedCalls: [],
    parseSnapshot,
    parseEvent,
    unexpected(name) {
      state.unexpectedCalls.push(name);
      throw new Error(`Unexpected lifecycle call: ${name}`);
    },
    async post(url, body, options) {
      state.requests.push({ method: "POST", url, body, options });
      state.operationId = body.operationId;
      return {
        status: 201,
        headers: {
          "x-teable-v2": "true",
          "x-teable-v2-feature": "deleteRecord",
          traceparent: "creation-trace",
          ...state.routingHeaders,
        },
        data: (state.createSnapshot ?? running)(),
      };
    },
    async get(url, options) {
      state.requests.push({ method: "GET", url, options });
      if (state.statusError) throw state.statusError;
      return {
        status: state.statusCode ?? 200,
        data: (state.statusSnapshot ?? snapshot)(),
      };
    },
  };
  globalThis.__deleteOperationTest = state;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    state.requests.push({ method: options.method, url, options });
    if (state.observerError) throw state.observerError;
    return streamResponse(
      state.streamText ? state.streamText() : frame(event()),
      state.observerStatus ?? 200,
    );
  });
});

test("creates one all-selection UUID operation and only GETs its observer and status", async () => {
  state.streamText = () =>
    ": heartbeat 删除\r\n\r\n" +
    frame({ id: "connect" }) +
    frame(
      event({
        id: "progress",
        status: "running",
        processedCount: 2,
        deletedCount: 2,
        revision: 2,
      }),
    ) +
    frame(event()) +
    frame({ id: "complete" });
  const result = await invoke();
  assert.match(result.operationId, uuidPattern);
  assert.deepEqual(
    state.requests.map(({ method }) => method),
    ["POST", "GET", "GET"],
  );
  const [create, observer, status] = state.requests;
  const operationPath = `/table/${tableId}/selection/delete-operations`;
  assert.equal(create.url, operationPath);
  assert.deepEqual(create.body, {
    operationId: result.operationId,
    viewId: "viw-delete-fixture",
    selection: { kind: "all" },
  });
  assert.equal(
    observer.url,
    `https://perf.invalid/api${operationPath}/${result.operationId}/stream`,
  );
  assert.equal(status.url, `${operationPath}/${result.operationId}`);
  assert.equal(observer.options.headers.Accept, "text/event-stream");
  for (const request of state.requests) {
    assert.equal(request.options.headers["x-teable-canary"], "true");
    assert.equal(request.options.headers["X-Window-Id"], "window-fixture");
    assert.equal(request.options.headers.Cookie, "session=fixture");
    assert.equal(request.options.headers.Authorization, "Bearer fixture");
    assert.equal(request.options.headers.ignored, undefined);
  }
  assert.equal(result.totalCount, 3);
  assert.equal(result.deletedCount, 3);
  assert.equal(result.progressEventCount, 2);
  assert.equal(result.snapshot.effectsStatus, "settled");
  assert.equal(result.observerStatus, 200);
  assert.equal(result.routing.routeMatched, true);
  assert.equal(result.timingProfile, DELETE_OPERATION_TIMING_PROFILE);
  assert.deepEqual(result.wire, {
    create: "POST",
    observe: "GET SSE",
    status: "GET",
    selection: "all",
  });
  assert.deepEqual(state.traceSteps, [
    "deleteAll-create-execution",
    "deleteAll-observe-readonly",
    "deleteAll-status-readonly",
  ]);
  assert.equal(state.traceRefs[0].method, "GET");
  assert.ok(state.watchdogPokes > 1);
});

for (const engine of ["v1", "local", undefined]) {
  test(`rejects ${engine ?? "unspecified"} helper intent without any request`, async () => {
    await assert.rejects(invoke({ context: { engine } }), /explicit V2 intent/);
    assert.deepEqual(state.requests, []);
  });
  test(`truly skips ${engine ?? "unspecified"} stream cases before the lifecycle`, async () => {
    const result = await runRecordDeleteStreamCase(perfCase, { engine });
    assert.equal(result.result, "skipped");
    assert.equal(result.details.skipped, true);
    assert.deepEqual(result.metrics, {});
    assert.deepEqual(result.thresholds, []);
    assert.deepEqual(state.unexpectedCalls, []);
    assert.deepEqual(state.requests, []);
  });
}

test("rejects a V1 route even when V2 was explicitly requested", async () => {
  state.routingHeaders = { "x-teable-v2": "false" };
  await rejected(invoke(), /expected V2 route/);
  assert.equal(state.requests.length, 1);
});

test("EOF without terminal state reads durable status once, fails and never reposts", async () => {
  state.streamText = () =>
    frame(event({ id: "progress", status: "running", revision: 2 }));
  state.statusSnapshot = () => running({ revision: 2 });
  await rejected(
    invoke(),
    /disconnected before terminal status/,
    running({ revision: 2 }),
  );
  assert.deepEqual(
    state.requests.map(({ method }) => method),
    ["POST", "GET", "GET"],
  );
});

test("terminal creation still confirms durable status without opening an observer", async () => {
  state.createSnapshot = snapshot;
  const result = await invoke();
  assert.equal(result.deletedCount, 3);
  assert.deepEqual(
    state.requests.map(({ method }) => method),
    ["POST", "GET"],
  );
  assert.equal(result.progressEventCount, 0);
});

const nonConverged = [
  ["failed", { status: "failed" }],
  ["partial", { status: "partial" }],
  ["cancelled", { status: "cancelled" }],
  ["error", { error: { message: "删除失败", code: "DELETE_FAILED" } }],
  ["total mismatch", { totalCount: 4 }],
  ["processed mismatch", { processedCount: 2 }],
  ["deleted mismatch", { deletedCount: 2 }],
  ["failed records", { failedCount: 1 }],
  ["failed effects", { effectsStatus: "failed" }],
  ["failed effect count", { failedEffectCount: 1 }],
  ["unsettled count", { pendingEffectCount: 1 }],
];
for (const [label, overrides] of nonConverged) {
  test(`does not report ${label} as convergence`, async () => {
    state.statusSnapshot = () => snapshot(overrides);
    await rejected(invoke(), /did not fully converge/, snapshot(overrides));
  });
}

test("pending effects are not ready even with successful deletion counts", () => {
  const pending = snapshot({ effectsStatus: "pending", pendingEffectCount: 1 });
  assert.throws(
    () => assertDeleteOperationReady(pending, 3),
    (error) => {
      assert.ok(error instanceof DeleteOperationObservationError);
      assert.deepEqual(error.snapshot, pending);
      return true;
    },
  );
});

test("pending effects are observed with GET until the durable receipt settles", async () => {
  let reads = 0;
  state.statusSnapshot = () =>
    ++reads === 1
      ? snapshot({ effectsStatus: "pending", pendingEffectCount: 1 })
      : snapshot({ revision: 4 });
  const result = await invoke();
  assert.equal(result.snapshot.revision, 4);
  assert.deepEqual(
    state.requests.map(({ method }) => method),
    ["POST", "GET", "GET", "GET"],
  );
  assert.equal(state.requests[2].url, state.requests[3].url);
});

test("cancellation while effects remain pending fails with the latest snapshot", async () => {
  const controller = new AbortController();
  const pending = () =>
    snapshot({ effectsStatus: "pending", pendingEffectCount: 1 });
  state.statusSnapshot = () => {
    controller.abort(new Error("observation cancelled"));
    return pending();
  };
  await rejected(
    invoke({ context: { engine: "v2", signal: controller.signal } }),
    /abort/i,
    pending(),
  );
  assert.equal(state.requests.length, 3);
});

for (const [label, overrides, pattern] of [
  ["cross-table", { tableId: "tbl-other" }, /scope mismatch/],
  [
    "cross-operation",
    { operationId: "00000000-0000-4000-8000-000000000001" },
    /scope mismatch/,
  ],
  ["regressed revision", { revision: 0 }, /revision regressed/],
]) {
  test(`rejects ${label} SSE snapshots`, async () => {
    state.streamText = () => frame(event(overrides));
    await rejected(invoke(), pattern, snapshot(overrides));
    assert.equal(state.requests.length, 2);
  });
  test(`rejects ${label} final status snapshots`, async () => {
    state.statusSnapshot = () => snapshot(overrides);
    await rejected(invoke(), pattern, snapshot(overrides));
    assert.equal(state.requests.length, 3);
  });
}

test("malformed SSE snapshots fail parsing and retain accepted creation evidence", async () => {
  state.streamText = () => frame(event({ deletedCount: "3" }));
  await rejected(invoke(), /invalid deletedCount/, running());
  assert.equal(state.requests.length, 2);
});

test("observer HTTP failure performs no status or mutation retry", async () => {
  state.observerStatus = 503;
  await rejected(invoke(), /observation returned HTTP 503/, running());
  assert.equal(state.requests.length, 2);
  assert.equal(state.cancelledStreams, 1);
  assert.equal(state.traceRefs[0].status, 503);
});

for (const boundary of ["observer", "status"]) {
  test(`${boundary} transport failure preserves its cause and latest snapshot without retry`, async () => {
    const cause = new Error(`${boundary} connection reset`);
    state[`${boundary}Error`] = cause;
    await assert.rejects(invoke(), (error) => {
      assert.ok(error instanceof DeleteOperationObservationError);
      assert.equal(error.cause, cause);
      assert.deepEqual(
        error.snapshot,
        boundary === "observer" ? running() : snapshot(),
      );
      return true;
    });
    assert.deepEqual(
      state.requests.map(({ method }) => method),
      boundary === "observer" ? ["POST", "GET"] : ["POST", "GET", "GET"],
    );
  });
}
