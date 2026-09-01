import { createHash } from "node:crypto";
import { arch, cpus, platform, release } from "node:os";
import type { MetricThreshold, PerfCase } from "./types";

export const MEASUREMENT_PROTOCOL_VERSION = "v1";

type Environment = Record<string, string | undefined>;

export interface MeasurementContract {
  id: string;
  protocolVersion: string;
  caseId: string;
  runner: string;
  engine: string;
  workloadDigest: string;
  primaryMetric?: {
    name: string;
    unit: string;
    direction: "lower-is-better" | "higher-is-better";
  };
  computedUpdateMode: string;
  sampleCount?: number;
  seedSchemaSignature?: string;
}

export interface MeasurementEnvironment {
  class: string;
  fingerprint: string;
  runnerOs: string;
  runnerArch: string;
  runnerImageOs?: string;
  runnerImageVersion?: string;
  cpuModel: string;
  cpuCount: number;
  nodeVersion: string;
  hostPlatform: string;
  hostRelease: string;
  databaseClass?: string;
  cpuCanaryMs?: number;
  databaseCanaryMs?: number;
}

export interface MeasurementExecution {
  lane: "historical" | "paired" | "local";
  jobId?: string;
  shardId?: string;
  perfLabSha?: string;
  teableEeSha?: string;
  experimentId?: string;
  variant?: "base" | "candidate";
  pairId?: string;
  pairOrder?: "base-candidate" | "candidate-base";
  sampleIndex?: number;
}

export interface MeasurementMetadata {
  contract: MeasurementContract;
  environment: MeasurementEnvironment;
  execution: MeasurementExecution;
}

const NON_WORKLOAD_KEYS = new Set(["maxMs", "timeoutMs", "watchdogMs"]);

const normalized = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(normalized);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(
          ([key, entry]) => !NON_WORKLOAD_KEYS.has(key) && entry !== undefined,
        )
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, normalized(entry)]),
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return String(value);
  }
  return value;
};

const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(normalized(value)))
    .digest("hex")
    .slice(0, 24);

const positiveInteger = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
};

const optionalInteger = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
};

const positiveNumber = (value: string | undefined) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

const laneOf = (value: string | undefined): MeasurementExecution["lane"] => {
  if (value === "paired") return "paired";
  if (value === "historical") return "historical";
  return "local";
};

const variantOf = (
  value: string | undefined,
): MeasurementExecution["variant"] =>
  value === "base" || value === "candidate" ? value : undefined;

const pairOrderOf = (
  value: string | undefined,
): MeasurementExecution["pairOrder"] =>
  value === "base-candidate" || value === "candidate-base" ? value : undefined;

const firstCpuModel = () => cpus()[0]?.model?.trim() || "unknown";

export const workloadDigestOf = (perfCase: PerfCase) =>
  digest({
    caseId: perfCase.id,
    runner: perfCase.runner,
    config: perfCase.config,
    routingEvidence: perfCase.routingEvidence,
    expectedSkipEngines: perfCase.expectedSkipEngines,
    seedAffinity: perfCase.seedAffinity,
    runtimeEnv: perfCase.runtimeEnv,
  });

export const buildMeasurementMetadata = ({
  perfCase,
  engine,
  primaryThreshold,
  env = process.env,
  host = {},
}: {
  perfCase: PerfCase;
  engine: string;
  primaryThreshold?: MetricThreshold;
  env?: Environment;
  host?: {
    cpuModel?: string;
    cpuCount?: number;
    platform?: string;
    arch?: string;
    release?: string;
    nodeVersion?: string;
  };
}): MeasurementMetadata => {
  const workloadDigest = workloadDigestOf(perfCase);
  const sampleCount = positiveInteger(env.PERF_LAB_SAMPLES);
  const computedUpdateMode =
    env.PERF_LAB_COMPUTED_UPDATE_MODE?.trim() || "sync";
  const seedSchemaSignature =
    env.PERF_LAB_SEED_SCHEMA_SIGNATURE?.trim() || undefined;
  const primaryMetric = primaryThreshold
    ? {
        name: primaryThreshold.metric,
        unit: primaryThreshold.unit,
        direction: "lower-is-better" as const,
      }
    : undefined;

  const contractWithoutId = {
    protocolVersion: MEASUREMENT_PROTOCOL_VERSION,
    caseId: perfCase.id,
    runner: perfCase.runner,
    workloadDigest,
    primaryMetric,
    engine,
    computedUpdateMode,
    sampleCount,
    seedSchemaSignature,
  };
  const contract: MeasurementContract = {
    id: digest(contractWithoutId),
    ...contractWithoutId,
  };

  const runnerOs = env.RUNNER_OS?.trim() || host.platform || platform();
  const runnerArch = env.RUNNER_ARCH?.trim() || host.arch || arch();
  const environmentWithoutFingerprint = {
    runnerOs,
    runnerArch,
    runnerImageOs: env.ImageOS?.trim() || undefined,
    runnerImageVersion: env.ImageVersion?.trim() || undefined,
    cpuModel: host.cpuModel || firstCpuModel(),
    cpuCount: host.cpuCount ?? cpus().length,
    nodeVersion: host.nodeVersion || process.version,
    hostPlatform: host.platform || platform(),
    hostRelease: host.release || release(),
    databaseClass: env.PERF_LAB_DATABASE_CLASS?.trim() || undefined,
  };
  const environmentClass = [
    "runner",
    runnerOs,
    runnerArch,
    environmentWithoutFingerprint.databaseClass || "postgres-default",
  ].join(":");
  const environment: MeasurementEnvironment = {
    class: environmentClass,
    fingerprint: digest({
      class: environmentClass,
      ...environmentWithoutFingerprint,
    }),
    ...environmentWithoutFingerprint,
    cpuCanaryMs: positiveNumber(env.PERF_LAB_CPU_CANARY_MS),
    databaseCanaryMs: positiveNumber(env.PERF_LAB_DATABASE_CANARY_MS),
  };

  return {
    contract,
    environment,
    execution: {
      lane: laneOf(env.PERF_LAB_RUN_LANE),
      jobId: env.CI_JOB_ID?.trim() || env.GITHUB_JOB?.trim() || undefined,
      shardId: env.PERF_LAB_SHARD_ID?.trim() || undefined,
      perfLabSha:
        env.PERF_LAB_SHA?.trim() || env.GITHUB_SHA?.trim() || undefined,
      teableEeSha: env.PERF_LAB_TEABLE_EE_SHA?.trim() || undefined,
      experimentId: env.PERF_LAB_EXPERIMENT_ID?.trim() || undefined,
      variant: variantOf(env.PERF_LAB_VARIANT),
      pairId: env.PERF_LAB_PAIR_ID?.trim() || undefined,
      pairOrder: pairOrderOf(env.PERF_LAB_PAIR_ORDER),
      sampleIndex: optionalInteger(env.PERF_LAB_SAMPLE_INDEX),
    },
  };
};
