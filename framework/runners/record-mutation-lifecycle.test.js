import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

// The lifecycle imports record-replay.shared only for the window helpers. Mock
// that Teable-bound module while transpiling the real lifecycle source graph in
// memory, so this contract test can run in perf-lab itself.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith("/record-replay.shared")) {
      return nextResolve(`${specifier}.ts`, context);
    }
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
    if (url.endsWith("/record-replay.shared.ts")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const buildRecordWindowId = (_context, perfCase) => \`window-\${perfCase.id}\`;
          export const withRecordWindowId = async (_windowId, callback) => callback();
        `,
      };
    }
    if (!url.endsWith(".ts")) {
      return nextLoad(url, context);
    }
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: fileURLToPath(url),
      }).outputText,
    };
  },
});

const { runRecordMutationLifecycle } = await import(
  "./record-mutation-lifecycle.ts"
);
const { PerfRunDiagnosticError } = await import("../types.ts");

test("domain table-name resolver reaches the real lifecycle fixture adapter", async () => {
  globalThis.testConfig = { baseId: "base-contract" };
  let preparedTableName;
  let cleanupArgs;

  const perfCase = {
    id: "conditional-query/contract",
    title: "Conditional query record mutation contract",
    runner: "conditional-query",
    timeoutMs: 1_000,
    config: {
      sourceTableNamePrefix: "conditional-source",
    },
  };
  const context = {
    app: {},
    appUrl: "http://localhost",
    runId: "run-contract",
    engine: "v2",
  };
  const spec = {
    resolveTableNamePrefix: (config) => config.sourceTableNamePrefix,
    prepareFixture: async ({ tableName }) => {
      preparedTableName = tableName;
      return { tableName };
    },
    runMeasuredOperation: async () => ({
      name: "mutation",
      durationMs: 7,
      result: { updatedRecords: 1 },
    }),
    buildResult: ({ primaryMeasurement }) => ({
      result: "pass",
      metrics: {
        mutationMs: primaryMeasurement?.durationMs ?? 0,
      },
      thresholds: [],
    }),
    cleanup: async (args) => {
      cleanupArgs = args;
    },
  };

  const result = await runRecordMutationLifecycle(perfCase, context, spec);

  assert.match(preparedTableName, /^conditional-source-\d+$/);
  assert.equal(result.result, "pass");
  assert.equal(result.metrics.mutationMs, 7);
  assert.equal(cleanupArgs.fixture.tableName, preparedTableName);
});

test("measured diagnostic failures preserve partial primary evidence", async () => {
  globalThis.testConfig = { baseId: "base-contract" };
  const partialPrimaryMeasurement = {
    name: "customerFlowReadyTotalMs",
    durationMs: 5432,
    result: { completedWrites: 2, targetReadAttempts: 31 },
  };
  let cleanupArgs;

  const perfCase = {
    id: "lookup/customer-diagnostic-contract",
    title: "Customer diagnostic contract",
    runner: "customer-upsert-computed-flow",
    timeoutMs: 1_000,
    config: { tableNamePrefix: "customer-diagnostic" },
  };
  const context = {
    app: {},
    appUrl: "http://localhost",
    runId: "run-diagnostic-contract",
    engine: "v2",
  };
  const spec = {
    prepareFixture: async ({ tableName }) => ({ tableName }),
    runMeasuredOperation: async () => {
      throw new PerfRunDiagnosticError("computed propagation timed out", {
        metrics: {},
        thresholds: [],
        details: { partialPrimaryMeasurement },
      });
    },
    buildResult: ({ primaryMeasurement, error }) => ({
      result: error ? "fail" : "pass",
      metrics: {
        customerFlowReadyTotalMs: primaryMeasurement?.durationMs ?? 0,
        completedWrites: primaryMeasurement?.result.completedWrites ?? 0,
        targetReadAttempts: primaryMeasurement?.result.targetReadAttempts ?? 0,
      },
      thresholds: [],
    }),
    cleanup: async (args) => {
      cleanupArgs = args;
    },
  };

  await assert.rejects(
    runRecordMutationLifecycle(perfCase, context, spec),
    (error) => {
      assert.equal(error.name, "PerfRunDiagnosticError");
      assert.equal(error.result.metrics.customerFlowReadyTotalMs, 5432);
      assert.equal(error.result.metrics.completedWrites, 2);
      assert.equal(error.result.metrics.targetReadAttempts, 31);
      return true;
    },
  );
  assert.equal(
    cleanupArgs.primaryMeasurement.durationMs,
    partialPrimaryMeasurement.durationMs,
  );
});
