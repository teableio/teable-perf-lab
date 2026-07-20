export type LifecycleFixtureSample = {
  iteration: number;
};

export const getLifecycleFixtureCount = (
  sampleCount: number,
  reuseFixtureAcrossSamples: boolean,
) => {
  if (!Number.isInteger(sampleCount) || sampleCount < 1) {
    throw new Error("Lifecycle sample count must be a positive integer");
  }
  return reuseFixtureAcrossSamples ? 1 : sampleCount;
};

export const buildLifecycleExecutionSamples = <
  TSample extends LifecycleFixtureSample,
>({
  fixtureSamples,
  sampleCount,
  reuseFixtureAcrossSamples,
}: {
  fixtureSamples: TSample[];
  sampleCount: number;
  reuseFixtureAcrossSamples: boolean;
}): TSample[] => {
  const expectedFixtureCount = getLifecycleFixtureCount(
    sampleCount,
    reuseFixtureAcrossSamples,
  );
  if (fixtureSamples.length !== expectedFixtureCount) {
    throw new Error(
      `Lifecycle fixture count mismatch: expected ${expectedFixtureCount}, received ${fixtureSamples.length}`,
    );
  }

  if (!reuseFixtureAcrossSamples) {
    return fixtureSamples;
  }

  const fixtureSample = fixtureSamples[0]!;
  return Array.from({ length: sampleCount }, (_, index) => ({
    ...fixtureSample,
    iteration: index + 1,
  }));
};
