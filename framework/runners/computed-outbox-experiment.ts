export type PausedBacklogEvidence = {
  queuePaused: boolean;
  queuePausedJobs: number;
  queueActiveJobs: number;
  outboxPending: number;
  outboxProcessing: number;
  outboxDead: number;
  oldestTaskAgeMs: number;
  sourceCommitted: boolean;
  formulaStillStale: boolean;
};

export const assertPausedBacklogEvidence = (
  evidence: PausedBacklogEvidence,
): void => {
  const visiblePausedWork =
    evidence.queuePaused &&
    evidence.queuePausedJobs > 0 &&
    evidence.queueActiveJobs === 0 &&
    evidence.outboxPending > 0 &&
    evidence.outboxProcessing === 0 &&
    evidence.outboxDead === 0 &&
    evidence.oldestTaskAgeMs > 0 &&
    evidence.sourceCommitted &&
    evidence.formulaStillStale;

  if (!visiblePausedWork) {
    throw new Error(
      `Computed Outbox paused backlog was not visible: ${JSON.stringify(evidence)}`,
    );
  }
};

export type ObserverAbTreatment = {
  pollIntervalMs: 5 | 50;
  propagationReadyMs: number;
  sampleCount: number;
};

export type ObserverAbComparison = {
  order: Array<5 | 50>;
  fiveMs: ObserverAbTreatment;
  fiftyMs: ObserverAbTreatment;
  maxPropagationReadyMs: number;
  propagationDeltaMs: number;
  propagationRatio: number;
  sampleCountDelta: number;
  sampleCountRatio: number;
};

export const buildObserverAbComparison = (
  treatments: ObserverAbTreatment[],
): ObserverAbComparison => {
  const fiveMsTreatments = treatments.filter(
    (treatment) => treatment.pollIntervalMs === 5,
  );
  const fiftyMsTreatments = treatments.filter(
    (treatment) => treatment.pollIntervalMs === 50,
  );
  if (
    treatments.length !== 2 ||
    fiveMsTreatments.length !== 1 ||
    fiftyMsTreatments.length !== 1
  ) {
    throw new Error(
      "Computed Outbox observer A/B requires exactly one 5 ms and one 50 ms treatment",
    );
  }

  const fiveMs = fiveMsTreatments[0];
  const fiftyMs = fiftyMsTreatments[0];
  if (
    !fiveMs ||
    !fiftyMs ||
    fiveMs.propagationReadyMs <= 0 ||
    fiftyMs.propagationReadyMs <= 0 ||
    fiveMs.sampleCount <= 0 ||
    fiftyMs.sampleCount <= 0
  ) {
    throw new Error(
      "Computed Outbox observer A/B treatments require positive durations and sample counts",
    );
  }

  return {
    order: treatments.map((treatment) => treatment.pollIntervalMs),
    fiveMs,
    fiftyMs,
    maxPropagationReadyMs: Math.max(
      fiveMs.propagationReadyMs,
      fiftyMs.propagationReadyMs,
    ),
    propagationDeltaMs: fiveMs.propagationReadyMs - fiftyMs.propagationReadyMs,
    propagationRatio: fiveMs.propagationReadyMs / fiftyMs.propagationReadyMs,
    sampleCountDelta: fiveMs.sampleCount - fiftyMs.sampleCount,
    sampleCountRatio: fiveMs.sampleCount / fiftyMs.sampleCount,
  };
};
