import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

// The perf runner source uses the extensionless TypeScript imports expected by
// teable-ee. This local-only hook transpiles that real source graph in memory so
// the contract test runs the lifecycle itself without loading teable-ee.
registerHooks({
  resolve(specifier, context, nextResolve) {
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

const [{ runFieldAddLifecycle }, { PerfRunDiagnosticError }] =
  await Promise.all([
    import("./field-add-lifecycle.ts"),
    import("../types.ts"),
  ]);

test("field-add preserves completed phases in a real diagnostic error and always cleans up", async () => {
  globalThis.testConfig = { baseId: "base-contract" };
  let cleanupArgs;
  let diagnosticBuildCount = 0;

  const perfCase = {
    id: "conditional-query/contract",
    title: "Conditional query lifecycle contract",
    runner: "conditional-query",
    timeoutMs: 1_000,
    config: {
      threshold: { metric: "conditionalQueryReadyMs", maxMs: 2_500 },
    },
  };
  const context = {
    app: {},
    appUrl: "http://localhost",
    runId: "run-contract",
    engine: "v2",
  };
  const spec = {
    prepareFixture: async () => ({
      id: "tbl-host",
      completedPrimaryPhases: [],
    }),
    assertSeedReady: async () => ({ scannedRecords: 2_000 }),
    runPrimary: async ({ fixture }) => {
      fixture.completedPrimaryPhases.push({
        name: "createConditionalField",
        durationMs: 31,
      });
      throw new Error("conditional backfill scan timed out");
    },
    buildResult: ({ fixture, seedReadyMeasurement, error }) => {
      diagnosticBuildCount += 1;
      return {
        metrics: {
          seedReadyMs: seedReadyMeasurement?.durationMs ?? 0,
          conditionalFieldCreateMs:
            fixture?.completedPrimaryPhases[0]?.durationMs ?? 0,
        },
        thresholds: [
          {
            metric: "conditionalQueryReadyMs",
            max: 2_500,
            unit: "ms",
          },
        ],
        phases: [
          ...(seedReadyMeasurement
            ? [
                {
                  name: seedReadyMeasurement.name,
                  durationMs: seedReadyMeasurement.durationMs,
                },
              ]
            : []),
          ...(fixture?.completedPrimaryPhases ?? []),
        ],
        details: {
          fixtureId: fixture?.id,
          error: error instanceof Error ? error.message : undefined,
        },
      };
    },
    cleanup: async (args) => {
      cleanupArgs = args;
    },
  };

  let diagnostic;
  await assert.rejects(
    () => runFieldAddLifecycle(perfCase, context, spec),
    (error) => {
      assert.ok(error instanceof PerfRunDiagnosticError);
      diagnostic = error;
      return true;
    },
  );

  assert.equal(diagnostic.name, "PerfRunDiagnosticError");
  assert.equal(diagnostic.message, "conditional backfill scan timed out");
  assert.equal(diagnosticBuildCount, 1);
  assert.deepEqual(diagnostic.result.thresholds, [
    { metric: "conditionalQueryReadyMs", max: 2_500, unit: "ms" },
  ]);
  assert.equal(diagnostic.result.phases[0].name, "seedReady");
  assert.ok(diagnostic.result.phases[0].durationMs >= 0);
  assert.deepEqual(diagnostic.result.phases[1], {
    name: "createConditionalField",
    durationMs: 31,
  });
  assert.equal(diagnostic.result.metrics.conditionalFieldCreateMs, 31);
  assert.deepEqual(diagnostic.result.details, {
    fixtureId: "tbl-host",
    error: "conditional backfill scan timed out",
  });
  assert.equal(cleanupArgs.baseId, "base-contract");
  assert.equal(cleanupArgs.fixture.id, "tbl-host");
  assert.equal(cleanupArgs.primaryAttempted, true);
});
