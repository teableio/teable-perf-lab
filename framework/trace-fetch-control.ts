export type TraceFetchBreakerState =
  | "closed"
  | "partial-loss"
  | "hard-outage"
  | "case-budget"
  | "job-budget"
  | "recovered";

export type TraceFetchArtifactState =
  | TraceFetchBreakerState
  | "exporter-outage";

export type TraceFetchDecision =
  | { action: "fetch"; mode: "normal" | "recovery-probe" }
  | { action: "skip"; reason: string };

export type TraceFetchOutcome =
  | { status: "saved" }
  | { status: "missing"; error?: string }
  | { status: "unavailable"; error: string };

export type TraceFetchControlSnapshot = {
  state: TraceFetchBreakerState;
  reason?: string;
  missingCount: number;
  recoveryProbeCount: number;
  recoverySucceeded: boolean;
};

const assertPositiveInteger = (value: number, label: string) => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
};

export const createTraceFetchControl = ({
  partialLossThreshold,
  recoveryProbeLimit,
}: {
  partialLossThreshold: number;
  recoveryProbeLimit: number;
}) => {
  assertPositiveInteger(partialLossThreshold, "partialLossThreshold");
  assertPositiveInteger(recoveryProbeLimit, "recoveryProbeLimit");

  let state: TraceFetchBreakerState = "closed";
  let reason: string | undefined;
  let missingCount = 0;
  let recoveryProbeCount = 0;
  let recoveryProbeInFlight = false;
  let recoverySucceeded = false;

  const partialLossReason = () =>
    `Trace fetch breaker open: partial loss threshold ${partialLossThreshold} reached`;

  const next = (): TraceFetchDecision => {
    if (state === "closed" || state === "recovered") {
      return { action: "fetch", mode: "normal" };
    }
    if (state !== "partial-loss") {
      return {
        action: "skip",
        reason: reason ?? `Trace fetch breaker open: ${state}`,
      };
    }
    if (recoveryProbeCount < recoveryProbeLimit && !recoveryProbeInFlight) {
      recoveryProbeCount += 1;
      recoveryProbeInFlight = true;
      return { action: "fetch", mode: "recovery-probe" };
    }

    const suffix = recoveryProbeInFlight
      ? "recovery probe already in flight"
      : `recovery probe limit ${recoveryProbeLimit} exhausted`;
    reason = `${partialLossReason()}; ${suffix}`;
    return { action: "skip", reason };
  };

  const record = (decision: TraceFetchDecision, outcome: TraceFetchOutcome) => {
    if (decision.action !== "fetch") {
      throw new Error(
        "Cannot record a trace fetch outcome for a skip decision",
      );
    }
    if (decision.mode === "recovery-probe") {
      recoveryProbeInFlight = false;
    }

    if (outcome.status === "saved") {
      if (decision.mode === "recovery-probe") {
        state = "recovered";
        reason = undefined;
        missingCount = 0;
        recoverySucceeded = true;
      }
      return;
    }

    missingCount += 1;
    if (outcome.status === "unavailable") {
      state = "hard-outage";
      reason = `Trace fetch breaker open: Jaeger unavailable: ${outcome.error}`;
      return;
    }

    if (missingCount >= partialLossThreshold) {
      state = "partial-loss";
      reason =
        decision.mode === "recovery-probe" &&
        recoveryProbeCount >= recoveryProbeLimit
          ? `${partialLossReason()}; recovery probe limit ${recoveryProbeLimit} exhausted`
          : partialLossReason();
    }
  };

  const stop = (
    nextState: Extract<TraceFetchBreakerState, "case-budget" | "job-budget">,
    nextReason: string,
  ) => {
    state = nextState;
    reason = nextReason;
  };

  const snapshot = (): TraceFetchControlSnapshot => ({
    state,
    ...(reason ? { reason } : {}),
    missingCount,
    recoveryProbeCount,
    recoverySucceeded,
  });

  return { next, record, stop, snapshot };
};
