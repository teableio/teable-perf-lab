import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const source = await readFile("framework/trace-classification.ts", "utf8");
const output = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
  fileName: "framework/trace-classification.ts",
  reportDiagnostics: true,
});

const errors = (output.diagnostics ?? []).filter(
  (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.equal(errors.length, 0);

const tempDir = await mkdtemp(join(tmpdir(), "perf-lab-trace-classification-"));
const tempFile = join(tempDir, "trace-classification.mjs");

try {
  await writeFile(tempFile, output.outputText);
  const { hasSavedTraceStepShape, normalizeTraceStepShape } = await import(
    pathToFileURL(tempFile)
  );

  assert.equal(
    normalizeTraceStepShape("formSubmitP95Ms:150"),
    "formSubmitP95Ms:#",
  );
  assert.equal(
    normalizeTraceStepShape("duplicateSingleP95Ms-32"),
    "duplicateSingleP95Ms-#",
  );
  assert.equal(
    normalizeTraceStepShape("deleteTableVerify-sample-03"),
    "deleteTableVerify-sample-#",
  );
  assert.equal(
    normalizeTraceStepShape("on:lookup-key-capped-hit:sample-10"),
    "on:lookup-key-capped-hit:sample-#",
  );

  // A mid-string numeric segment is a distinct operation key, not a repeat
  // index, so it must survive normalization (these two stay different shapes).
  assert.equal(
    normalizeTraceStepShape("host:2024:sample-05"),
    "host:2024:sample-#",
  );
  assert.notEqual(
    normalizeTraceStepShape("host:2024:sample-05"),
    normalizeTraceStepShape("host:2025:sample-05"),
  );

  // Producer contract: structurally distinct steps are named, not indexed, so
  // they stay distinct shapes (record-read seed fields). A bare `:1`/`:2` would
  // collapse and let one saved trace falsely cover another field's 404.
  assert.notEqual(
    normalizeTraceStepShape("seedBuild:createFormulaField:Formula 1"),
    normalizeTraceStepShape("seedBuild:createFormulaField:Formula 2"),
  );
  assert.equal(
    normalizeTraceStepShape("seedBuild:createFormulaField:1"),
    normalizeTraceStepShape("seedBuild:createFormulaField:2"),
  );

  assert.equal(
    hasSavedTraceStepShape(
      { traceId: "bad", stepId: "duplicateTableRequestMs" },
      [
        { traceId: "ok", stepId: "duplicateTableRequestMs" },
        { traceId: "bad", stepId: "duplicateTableRequestMs" },
      ],
      new Set(["ok"]),
    ),
    true,
  );
  assert.equal(
    hasSavedTraceStepShape(
      { traceId: "bad", stepId: "deleteTableVerify-sample-03" },
      [
        { traceId: "ok", stepId: "deleteTableVerify-sample-01" },
        { traceId: "bad", stepId: "deleteTableVerify-sample-03" },
      ],
      new Set(["ok"]),
    ),
    true,
  );
  assert.equal(
    hasSavedTraceStepShape(
      { traceId: "bad", stepId: "undoSetup1k" },
      [
        { traceId: "ok", stepId: "undoReplay1kMs" },
        { traceId: "bad", stepId: "undoSetup1k" },
      ],
      new Set(["ok"]),
    ),
    false,
  );

  console.log("Trace classification checks ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
