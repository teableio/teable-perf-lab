import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { buildMeasurementMetadata } from "./framework/measurement-contract";
import type { MetricThreshold } from "./framework/types";
import { getPerfCase, resolvePerfCaseIdsWithExclusions } from "./registry";

const required = (name: string) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const primaryThresholdOf = (perfCase: ReturnType<typeof getPerfCase>) => {
  const threshold = (
    perfCase.config as { threshold?: { metric?: string; maxMs?: number } }
  ).threshold;
  if (!threshold?.metric || !Number.isFinite(threshold.maxMs)) {
    throw new Error(`Case ${perfCase.id} has no primary threshold contract`);
  }
  return {
    metric: threshold.metric,
    max: threshold.maxMs,
    unit: "ms",
  } satisfies MetricThreshold;
};

describe("paired measurement contract preflight", () => {
  it("emits contracts without executing the application or case runners", async () => {
    const caseIds = resolvePerfCaseIdsWithExclusions(
      required("PERF_LAB_CASE_FILTER"),
      undefined,
    );
    const engine = required("PERF_LAB_PAIRED_ENGINE");
    const outputPath = resolve(required("PERF_LAB_PAIRED_CONTRACT_OUTPUT"));
    const contracts = Object.fromEntries(
      caseIds.map((caseId) => {
        const perfCase = getPerfCase(caseId);
        if (perfCase.expectedSkipEngines?.includes(engine as "v1" | "v2")) {
          throw new Error(`Case ${caseId} does not support engine ${engine}`);
        }
        return [
          caseId,
          buildMeasurementMetadata({
            perfCase,
            engine,
            primaryThreshold: primaryThresholdOf(perfCase),
          }).contract,
        ];
      }),
    );
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(
      outputPath,
      `${JSON.stringify(
        {
          variant: required("PERF_LAB_VARIANT"),
          teableEeSha: required("PERF_LAB_TEABLE_EE_SHA"),
          perfLabSha: required("PERF_LAB_SHA"),
          contracts,
        },
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    expect(Object.keys(contracts)).toHaveLength(caseIds.length);
  });
});
