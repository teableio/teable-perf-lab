import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const source = await readFile("framework/trace-fetch-control.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "framework/trace-fetch-control.ts",
  reportDiagnostics: true,
});
const errors = (output.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.equal(errors.length, 0);

const tempDir = await mkdtemp(join(tmpdir(), "perf-lab-trace-fetch-control-"));
const modulePath = join(tempDir, "trace-fetch-control.mjs");

try {
  await writeFile(modulePath, output.outputText);
  const { createTraceFetchControl } = await import(pathToFileURL(modulePath));

  const healthy = createTraceFetchControl({
    partialLossThreshold: 2,
    recoveryProbeLimit: 1,
  });
  const healthyDecision = healthy.next();
  assert.deepEqual(healthyDecision, { action: "fetch", mode: "normal" });
  healthy.record(healthyDecision, { status: "saved" });
  assert.deepEqual(healthy.snapshot(), {
    state: "closed",
    missingCount: 0,
    recoveryProbeCount: 0,
    recoverySucceeded: false,
  });

  const partialLoss = createTraceFetchControl({
    partialLossThreshold: 2,
    recoveryProbeLimit: 1,
  });
  for (let index = 0; index < 2; index += 1) {
    const decision = partialLoss.next();
    partialLoss.record(decision, { status: "missing" });
  }
  assert.match(partialLoss.snapshot().reason, /partial loss threshold 2/);
  const failedProbe = partialLoss.next();
  assert.deepEqual(failedProbe, {
    action: "fetch",
    mode: "recovery-probe",
  });
  partialLoss.record(failedProbe, { status: "missing" });
  const partialSkip = partialLoss.next();
  assert.equal(partialSkip.action, "skip");
  assert.match(partialSkip.reason, /recovery probe limit 1 exhausted/);
  assert.deepEqual(partialLoss.snapshot(), {
    state: "partial-loss",
    reason:
      "Trace fetch breaker open: partial loss threshold 2 reached; recovery probe limit 1 exhausted",
    missingCount: 3,
    recoveryProbeCount: 1,
    recoverySucceeded: false,
  });

  const recovered = createTraceFetchControl({
    partialLossThreshold: 1,
    recoveryProbeLimit: 1,
  });
  const missing = recovered.next();
  recovered.record(missing, { status: "missing" });
  const recoveryProbe = recovered.next();
  recovered.record(recoveryProbe, { status: "saved" });
  assert.equal(recovered.snapshot().state, "recovered");
  assert.equal(recovered.snapshot().recoverySucceeded, true);
  assert.deepEqual(recovered.next(), { action: "fetch", mode: "normal" });

  const hardOutage = createTraceFetchControl({
    partialLossThreshold: 2,
    recoveryProbeLimit: 1,
  });
  const outageDecision = hardOutage.next();
  hardOutage.record(outageDecision, {
    status: "unavailable",
    error: "connect ECONNREFUSED jaeger",
  });
  assert.deepEqual(hardOutage.snapshot(), {
    state: "hard-outage",
    reason:
      "Trace fetch breaker open: Jaeger unavailable: connect ECONNREFUSED jaeger",
    missingCount: 1,
    recoveryProbeCount: 0,
    recoverySucceeded: false,
  });
  assert.match(hardOutage.next().reason, /Jaeger unavailable/);

  const budget = createTraceFetchControl({
    partialLossThreshold: 2,
    recoveryProbeLimit: 1,
  });
  budget.stop("case-budget", "Trace fetch case budget 15000ms exhausted");
  assert.equal(budget.snapshot().state, "case-budget");
  assert.match(budget.next().reason, /case budget 15000ms exhausted/);

  console.log("Trace fetch control checks ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
