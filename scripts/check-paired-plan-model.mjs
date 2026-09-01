import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  caseContractsFromPreflight,
  main,
  PAIRED_CONTRACT_MANIFEST_REVISION,
  parseExplicitCaseIds,
  resolvePairedCaseIds,
} from "./create-paired-plan.mjs";
import {
  PAIRED_MEASUREMENT_PROTOCOL_VERSION,
  PAIRED_PLAN_REVISION,
  measurementContractIdOf,
} from "./paired-experiment-model.mjs";

const catalog = [
  { id: "record-read/a" },
  { id: "record-read/b", expectedSkipEngines: ["v1"] },
];

assert.deepEqual(parseExplicitCaseIds(" record-read/b,record-read/a "), [
  "record-read/b",
  "record-read/a",
]);
assert.throws(() => parseExplicitCaseIds("all"), /explicit/);
assert.throws(() => parseExplicitCaseIds("record-read/*"), /explicit/);
assert.throws(
  () => parseExplicitCaseIds("record-read/a,record-read/a"),
  /duplicates/,
);
assert.deepEqual(
  resolvePairedCaseIds({
    catalog,
    rawCaseIds: "record-read/b,record-read/a",
    engine: "v2",
  }),
  ["record-read/a", "record-read/b"],
);
assert.throws(
  () =>
    resolvePairedCaseIds({
      catalog,
      rawCaseIds: "record-read/missing",
      engine: "v2",
    }),
  /Unknown paired case IDs/,
);
assert.throws(
  () =>
    resolvePairedCaseIds({
      catalog,
      rawCaseIds: "record-read/b",
      engine: "v1",
    }),
  /do not support engine v1/,
);

const outputDir = await mkdtemp(join(tmpdir(), "paired-plan-"));
const outputPath = join(outputDir, "nested", "paired-plan.json");
const preflightPath = join(outputDir, "paired-contract-preflight.json");
const contractOf = (caseId) => {
  const withoutId = {
    protocolVersion: "v1",
    caseId,
    runner: "record-read",
    workloadDigest: caseId.endsWith("a") ? "a".repeat(24) : "b".repeat(24),
    primaryMetric: {
      name: "durationMs",
      unit: "ms",
      direction: "lower-is-better",
    },
    engine: "v2",
    computedUpdateMode: "hybrid",
    sampleCount: 3,
    seedSchemaSignature: "schema-a",
  };
  return { id: measurementContractIdOf(withoutId), ...withoutId };
};
const preflight = {
  revision: PAIRED_CONTRACT_MANIFEST_REVISION,
  baseSha: "a".repeat(40),
  candidateSha: "b".repeat(40),
  perfLabSha: "c".repeat(40),
  engine: "v2",
  computedUpdateMode: "hybrid",
  sampleCount: 3,
  schemaSignature: "schema-a",
  cases: Object.fromEntries(
    ["record-read/a", "record-read/b"].map((caseId) => {
      const contract = contractOf(caseId);
      return [caseId, { base: contract, candidate: contract }];
    }),
  ),
};
await writeFile(preflightPath, JSON.stringify(preflight));
assert.throws(
  () =>
    caseContractsFromPreflight({
      manifest: {
        ...preflight,
        cases: {
          ...preflight.cases,
          "record-read/a": {
            ...preflight.cases["record-read/a"],
            candidate: contractOf("record-read/b"),
          },
        },
      },
      caseIds: ["record-read/a", "record-read/b"],
      baseSha: preflight.baseSha,
      candidateSha: preflight.candidateSha,
      perfLabSha: preflight.perfLabSha,
      engine: preflight.engine,
      computedUpdateMode: preflight.computedUpdateMode,
      sampleCount: preflight.sampleCount,
      schemaSignature: preflight.schemaSignature,
    }),
  /preflight contracts differ/,
);
const previous = { ...process.env };
try {
  Object.assign(process.env, {
    PERF_LAB_PAIRED_EXPERIMENT_ID: "experiment-a",
    PERF_LAB_PAIRED_BASE_SHA: "a".repeat(40),
    PERF_LAB_PAIRED_CANDIDATE_SHA: "b".repeat(40),
    PERF_LAB_SHA: "c".repeat(40),
    PERF_LAB_PAIRED_CASE_IDS: "record-read/b,record-read/a",
    PERF_LAB_PAIRED_ENGINE: "v2",
    PERF_LAB_PAIRED_PAIRS: "10",
    PERF_LAB_PAIRED_SAMPLE_COUNT: "3",
    PERF_LAB_COMPUTED_UPDATE_MODE: "hybrid",
    PERF_LAB_SEED_SCHEMA_SIGNATURE: "schema-a",
    PERF_LAB_PAIRED_CONTRACT_MANIFEST_PATH: preflightPath,
    PERF_LAB_PAIRED_PLAN_PATH: outputPath,
  });
  const plan = await main({
    catalogLoader: async () => catalog,
    perfLabIdentityReader: async () => "c".repeat(40),
  });
  assert.equal(plan.revision, PAIRED_PLAN_REVISION);
  assert.equal(plan.perfLabSha, "c".repeat(40));
  assert.deepEqual(plan.caseIds, ["record-read/a", "record-read/b"]);
  assert.equal(plan.caseFilter, "record-read/a,record-read/b");
  assert.equal(plan.order.length, 10);
  assert.deepEqual(plan.contract, {
    protocolVersion: PAIRED_MEASUREMENT_PROTOCOL_VERSION,
    computedUpdateMode: "hybrid",
    sampleCount: 3,
    seedSchemaSignature: "schema-a",
  });
  assert.deepEqual(plan.caseContracts, {
    "record-read/a": contractOf("record-read/a"),
    "record-read/b": contractOf("record-read/b"),
  });
  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), plan);
  await assert.rejects(
    main({
      catalogLoader: async () => catalog,
      perfLabIdentityReader: async () => "c".repeat(40),
    }),
    /EEXIST/,
    "an existing plan must not be silently overwritten",
  );
} finally {
  process.env = previous;
}

const measurementContractSource = await readFile(
  new URL("../framework/measurement-contract.ts", import.meta.url),
  "utf8",
);
assert.match(
  measurementContractSource,
  new RegExp(
    `MEASUREMENT_PROTOCOL_VERSION = ["']${PAIRED_MEASUREMENT_PROTOCOL_VERSION}["']`,
  ),
  "paired plan protocol must stay aligned with artifact measurement metadata",
);

console.log("paired plan checks passed");
