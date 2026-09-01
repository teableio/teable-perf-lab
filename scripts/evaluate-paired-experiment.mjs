// Offline half of a paired experiment.
//
// This command deliberately does not check out or execute product code and does
// not reset databases or caches. A trusted external runner supplies ordinary
// perf artifacts; this module validates their immutable identities, evaluates
// the paired statistics, and writes the auditable verdict.

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { env, requiredEnv } from "./env.mjs";
import { readArtifactPayloads } from "./perf-artifact-read-model.mjs";
import {
  assertFullCommitSha,
  evaluatePairedExperiment,
  isFullCommitSha,
} from "./paired-experiment-model.mjs";
import { assertPairedSchemaCompatibility } from "./paired-schema-read.mjs";

export const assertPairedArtifactIdentities = ({ payloads = [], plan }) => {
  const { experimentId, baseSha, candidateSha, perfLabSha } = plan ?? {};
  assertFullCommitSha(baseSha, "baseSha");
  assertFullCommitSha(candidateSha, "candidateSha");
  assertFullCommitSha(perfLabSha, "perfLabSha");
  if (
    !experimentId ||
    !plan?.schemaSignature ||
    !Array.isArray(plan.caseIds) ||
    plan.caseIds.length === 0
  ) {
    throw new Error(
      "Paired plan is missing experiment, schema, or resolved case identity",
    );
  }
  const plannedPairs = new Map();
  for (const pair of plan?.order ?? []) {
    if (
      !pair?.pairId ||
      plannedPairs.has(pair.pairId) ||
      !Number.isSafeInteger(pair.sampleIndex) ||
      !["base-candidate", "candidate-base"].includes(pair.order) ||
      pair.variants?.join("-") !== pair.order
    ) {
      throw new Error("Paired plan contains an invalid or duplicate pair");
    }
    plannedPairs.set(pair.pairId, pair);
  }
  const orderCounts = ["base-candidate", "candidate-base"].map(
    (order) =>
      [...plannedPairs.values()].filter((pair) => pair.order === order).length,
  );
  const sampleIndexes = new Set(
    [...plannedPairs.values()].map((pair) => pair.sampleIndex),
  );
  if (
    plannedPairs.size === 0 ||
    sampleIndexes.size !== plannedPairs.size ||
    Math.abs(orderCounts[0] - orderCounts[1]) > 1 ||
    (plannedPairs.size > 1 && orderCounts.includes(0))
  ) {
    throw new Error("Paired plan order is empty or unbalanced");
  }
  const coverage = new Map();
  for (const payload of payloads) {
    const execution = payload?.measurement?.execution;
    if (!plan.caseIds?.includes(payload.caseId)) {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} is outside the resolved case plan`,
      );
    }
    if (execution?.lane !== "paired") {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} is not a paired-lane observation`,
      );
    }
    if (
      payload.engine !== plan.engine ||
      payload.measurement?.contract?.seedSchemaSignature !==
        plan.schemaSignature
    ) {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} does not match the planned engine or schema contract`,
      );
    }
    if (execution.experimentId !== experimentId) {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} belongs to experiment ${execution.experimentId ?? "unknown"}, expected ${experimentId}`,
      );
    }
    const planned = plannedPairs.get(execution.pairId);
    if (
      !planned ||
      execution.pairOrder !== planned.order ||
      execution.sampleIndex !== planned.sampleIndex ||
      !planned.variants.includes(execution.variant)
    ) {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} does not match the balanced experiment plan`,
      );
    }
    if (
      !isFullCommitSha(execution.perfLabSha) ||
      execution.perfLabSha !== perfLabSha ||
      !execution.jobId ||
      !execution.shardId
    ) {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} is missing immutable execution provenance`,
      );
    }
    const expectedSha =
      execution.variant === "base"
        ? baseSha
        : execution.variant === "candidate"
          ? candidateSha
          : undefined;
    if (!expectedSha || execution.teableEeSha !== expectedSha) {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} has an invalid variant or product SHA`,
      );
    }
    const caseCoverage = coverage.get(payload.caseId) ?? new Map();
    const variants = caseCoverage.get(execution.pairId) ?? new Set();
    if (variants.has(execution.variant)) {
      throw new Error(
        `Artifact ${payload.caseId ?? "unknown"} duplicates ${execution.pairId}/${execution.variant}`,
      );
    }
    variants.add(execution.variant);
    caseCoverage.set(execution.pairId, variants);
    coverage.set(payload.caseId, caseCoverage);
  }
  for (const caseId of plan.caseIds ?? []) {
    const caseCoverage = coverage.get(caseId) ?? new Map();
    for (const pairId of plannedPairs.keys()) {
      const variants = caseCoverage.get(pairId);
      if (
        variants?.size !== 2 ||
        !variants.has("base") ||
        !variants.has("candidate")
      ) {
        throw new Error(
          `Artifact set for ${caseId} is incomplete at planned ${pairId}`,
        );
      }
    }
  }
};

export const markdownOf = (result) => {
  const lines = [
    "## Paired performance experiment",
    "",
    `Verdict: **${result.status.toUpperCase()}**`,
    "",
    `Policy: ${(result.policy.practicalRegression * 100).toFixed(1)}% practical budget · ${result.policy.minPairs} minimum pairs · ${(result.policy.confidence * 100).toFixed(0)}% CI · BH q≤${result.policy.falseDiscoveryRate}`,
    "",
    "| Case | Verdict | Candidate / base | Confidence interval | q | Pairs | MDE 80% | Environment |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const item of result.cases) {
    const ratio = Number.isFinite(item.ratio)
      ? `${item.ratio.toFixed(3)}x`
      : "n/a";
    const interval = item.confidenceInterval
      ? `[${item.confidenceInterval[0].toFixed(3)}x, ${item.confidenceInterval[1].toFixed(3)}x]`
      : "n/a";
    const adjusted = Number.isFinite(item.adjustedPValue)
      ? item.adjustedPValue.toPrecision(3)
      : "n/a";
    const mde = Number.isFinite(item.mde80)
      ? `${(item.mde80 * 100).toFixed(1)}%`
      : "n/a";
    const environment = item.environment?.controls
      ? Object.entries(item.environment.controls)
          .map(([name, control]) =>
            control.ratio
              ? `${name}:${control.status} ${control.ratio.toFixed(3)}x`
              : `${name}:${control.status}`,
          )
          .join("; ")
      : item.environment?.status || "unmeasured";
    lines.push(
      `| ${item.caseId} | ${item.status} | ${ratio} | ${interval} | ${adjusted} | ${item.pairs} | ${mde} | ${environment} |`,
    );
    if (item.reason) {
      lines.push(`| ↳ reason | ${item.reason} | | | | | | |`);
    }
  }
  lines.push(
    "",
    "Only `regression` is evidence for a code regression. `candidate` needs more data; `inconclusive` is never a pass.",
    "",
  );
  return lines.join("\n");
};

export const main = async ({
  verifySchema = assertPairedSchemaCompatibility,
} = {}) => {
  const artifactDir = resolve(requiredEnv("PERF_LAB_ARTIFACT_DIR"));
  const planPath = resolve(requiredEnv("PERF_LAB_PAIRED_PLAN_PATH"));
  const plan = JSON.parse(await readFile(planPath, "utf8"));
  const { experimentId, baseSha, candidateSha, perfLabSha } = plan;
  const schema = await verifySchema({
    baseDir: resolve(requiredEnv("PERF_LAB_PAIRED_BASE_DIR")),
    candidateDir: resolve(requiredEnv("PERF_LAB_PAIRED_CANDIDATE_DIR")),
    baseSha,
    candidateSha,
  });
  if (schema.baseDigest !== plan.schemaSignature) {
    throw new Error(
      "Paired plan schema signature does not match the verified checkouts",
    );
  }
  const entries = await readArtifactPayloads({
    artifactDir,
    includeSeed: false,
    allowEmpty: true,
  });
  const payloads = entries.map(({ payload }) => payload);
  assertPairedArtifactIdentities({
    payloads,
    plan,
  });
  const practicalRegression = Number(
    env("PERF_LAB_PRACTICAL_REGRESSION", "0.10"),
  );
  if (!(practicalRegression >= 0 && practicalRegression < 1)) {
    throw new Error(
      `PERF_LAB_PRACTICAL_REGRESSION must be in [0, 1), received ${practicalRegression}`,
    );
  }
  const result = evaluatePairedExperiment({
    payloads,
    policy: {
      practicalRegression,
    },
    seed: experimentId,
  });
  result.experiment = {
    id: experimentId,
    baseSha,
    candidateSha,
    perfLabSha,
    jobIds: [
      ...new Set(
        payloads
          .map((payload) => payload.measurement?.execution?.jobId)
          .filter(Boolean),
      ),
    ],
    shardIds: [
      ...new Set(
        payloads
          .map((payload) => payload.measurement?.execution?.shardId)
          .filter(Boolean),
      ),
    ],
    pairOrders: [
      ...new Set(
        payloads
          .map((payload) => payload.measurement?.execution?.pairOrder)
          .filter(Boolean),
      ),
    ],
    schemaSignature: plan.schemaSignature,
  };
  await writeFile(
    join(artifactDir, "paired-verdict.json"),
    `${JSON.stringify(result, null, 2)}\n`,
  );
  await writeFile(join(artifactDir, "paired-summary.md"), markdownOf(result));
  console.log(
    `Paired experiment evaluated: ${result.status}; ${entries.length} observations.`,
  );
};

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
