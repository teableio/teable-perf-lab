import type { PerfArtifactPayload } from "./artifacts";

export const thresholdDisposition = ({
  skipped,
  thresholds,
  observeOnly,
}: {
  skipped: boolean;
  thresholds: PerfArtifactPayload["thresholds"];
  observeOnly: boolean;
}) => {
  const failedThreshold = thresholds.find((threshold) => !threshold.passed);
  return {
    passed: skipped || observeOnly || failedThreshold == null,
    failedThreshold: skipped || observeOnly ? undefined : failedThreshold,
  };
};
