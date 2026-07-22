import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const transpile = async (fileName) =>
  ts.transpileModule(await readFile(fileName, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName,
    reportDiagnostics: true,
  });

const classificationOutput = await transpile(
  "framework/trace-classification.ts",
);
const evidencePolicyOutput = await transpile(
  "framework/trace-evidence-policy.ts",
);

const errors = [classificationOutput, evidencePolicyOutput]
  .flatMap((output) => output.diagnostics ?? [])
  .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
assert.equal(errors.length, 0);

const tempDir = await mkdtemp(join(tmpdir(), "perf-lab-trace-classification-"));
const classificationFile = join(tempDir, "trace-classification.mjs");
const evidencePolicyFile = join(tempDir, "trace-evidence-policy.mjs");

try {
  await writeFile(classificationFile, classificationOutput.outputText);
  await writeFile(
    evidencePolicyFile,
    evidencePolicyOutput.outputText.replace(
      'from "./trace-classification"',
      'from "./trace-classification.mjs"',
    ),
  );
  const { hasSavedTraceStepShape, normalizeTraceStepShape } = await import(
    pathToFileURL(classificationFile)
  );
  const { createTraceEvidencePolicy, normalizeTraceRequestBodyShape } =
    await import(pathToFileURL(evidencePolicyFile));

  assert.notEqual(
    normalizeTraceRequestBodyShape({
      records: [
        { fields: { Name: "A" } },
        { fields: { Name: "B" } },
        { fields: { Name: "C" } },
      ],
    }),
    normalizeTraceRequestBodyShape({
      records: [
        { fields: { Name: "A" } },
        { fields: { Name: "B", Count: 2 } },
        { fields: { Name: "C" } },
      ],
    }),
    "heterogeneous array element structures must not share a write representative",
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

  const refs = [
    {
      traceId: "ordinary",
      stepId: "listRecords:1",
      sampled: true,
      method: "GET",
      url: "http://teable.test/api/table/tblTraceShape001/record?page=1",
    },
    {
      traceId: "priority",
      stepId: "createFormulaField",
      sampled: true,
      method: "POST",
      url: "http://teable.test/api/table/tblTraceShape001/field",
    },
    {
      traceId: "ordinary-get-duplicate",
      stepId: "listRecords:1",
      sampled: true,
      method: "GET",
      url: "http://teable.test/api/table/tblOtherShape002/record?page=99",
    },
    {
      traceId: "ordinary-near",
      stepId: "listRecords:2",
      sampled: true,
      method: "GET",
      url: "http://teable.test/api/table/tblOtherShape002/record?page=2",
    },
    {
      traceId: "ordinary-far",
      stepId: "listRecords:10",
      sampled: true,
      method: "GET",
      url: "http://teable.test/api/table/tblOtherShape003/record?page=10",
    },
    {
      traceId: "not-sampled",
      stepId: "listRecords:3",
      sampled: false,
      method: "GET",
      url: "http://teable.test/api/table/tblTraceShape001/record?page=3",
    },
    {
      traceId: "excluded-by-include",
      stepId: "deleteRecords",
      sampled: true,
      method: "DELETE",
      url: "http://teable.test/api/table/tblTraceShape001/record",
    },
    {
      traceId: "capped",
      stepId: "otherIncluded",
      sampled: true,
      method: "GET",
      url: "http://teable.test/api/base/bseTraceShape001/dashboard",
    },
  ];
  const byId = (traceId) => refs.find((ref) => ref.traceId === traceId);
  const policy = createTraceEvidencePolicy({
    refs,
    includePattern: "listRecords|createFormulaField|otherIncluded",
    fallbackPattern: "listRecords",
    maxSnapshots: 2,
  });

  assert.deepEqual(
    policy.selectedRefs.map((ref) => ref.traceId),
    ["priority", "ordinary"],
  );
  assert.equal(
    policy.selectedRefs.some((ref) => ref.traceId === "ordinary-get-duplicate"),
    false,
  );
  assert.equal(
    policy.requestShape(refs[0]),
    "listRecords:# GET /api/table/:tbl/record?page",
  );
  assert.equal(
    policy.hasSavedRepresentative(refs[2], new Set(["ordinary"])),
    true,
  );
  assert.deepEqual(
    policy.fallbackCandidates(refs[0]).map((ref) => ref.traceId),
    ["ordinary-get-duplicate", "ordinary-near", "ordinary-far"],
  );
  assert.match(
    policy.explainUnfetched(refs[2], {
      savedTraceIds: new Set(["ordinary"]),
    }),
    /ordinary from listRecords:1 was saved as the representative/,
  );
  assert.equal(
    policy.explainUnfetched(byId("not-sampled"), {
      savedTraceIds: new Set(),
    }),
    "Traceparent is not sampled, so Jaeger is not expected to store it",
  );
  assert.equal(
    policy.explainUnfetched(byId("excluded-by-include"), {
      savedTraceIds: new Set(),
    }),
    "Sampled trace was not fetched because stepId did not match PERF_LAB_TRACE_INCLUDE_STEP_PATTERN=listRecords|createFormulaField|otherIncluded",
  );
  assert.equal(
    policy.explainUnfetched(byId("capped"), {
      savedTraceIds: new Set(),
    }),
    "Sampled trace was not fetched because PERF_LAB_TRACE_MAX_SNAPSHOTS=2",
  );

  const semanticRefs = [
    {
      traceId: "get-page-1",
      stepId: "scanPage:1",
      sampled: true,
      method: "GET",
      url: "http://teable.test/api/table/tblSemantic001/record?page=1",
    },
    {
      traceId: "get-page-2",
      stepId: "scanPage:2",
      sampled: true,
      method: "GET",
      url: "http://teable.test/api/table/tblSemantic002/record?page=2",
    },
    {
      traceId: "post-records-1",
      stepId: "writeBatch:1",
      sampled: true,
      method: "POST",
      url: "http://teable.test/api/table/tblSemantic001/record",
      requestBodyShape: normalizeTraceRequestBodyShape({
        records: [{ fields: { Name: "A", Count: 1 } }],
      }),
    },
    {
      traceId: "post-records-2",
      stepId: "writeBatch:2",
      sampled: true,
      method: "POST",
      url: "http://teable.test/api/table/tblSemantic002/record",
      requestBodyShape: normalizeTraceRequestBodyShape({
        records: [{ fields: { Name: "B", Count: 2 } }],
      }),
    },
    {
      traceId: "post-delete-ids",
      stepId: "writeBatch:3",
      sampled: true,
      method: "POST",
      url: "http://teable.test/api/table/tblSemantic003/record",
      requestBodyShape: normalizeTraceRequestBodyShape({
        recordIds: ["recSemantic001"],
      }),
    },
  ];
  const semanticPolicy = createTraceEvidencePolicy({
    refs: semanticRefs,
    maxSnapshots: 10,
  });
  assert.deepEqual(
    semanticPolicy.selectedRefs.map((ref) => ref.traceId),
    ["get-page-1", "post-records-1", "post-delete-ids"],
  );
  assert.equal(
    semanticPolicy.requestShape(semanticRefs[2]),
    'writeBatch:# POST /api/table/:tbl/record {"records":{"$arrayLength":1,"$itemShapes":[{"fields":{"Count":"number","Name":"string"}}]}}',
  );
  assert.notEqual(
    semanticPolicy.requestShape(semanticRefs[2]),
    semanticPolicy.requestShape(semanticRefs[4]),
  );

  console.log("Trace classification and evidence policy checks ok");
} finally {
  await rm(tempDir, { recursive: true, force: true });
}
