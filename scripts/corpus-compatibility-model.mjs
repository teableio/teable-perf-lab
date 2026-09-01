export const CONFIRMED_STRICT_MIN_POINTS = 30;

export const preferredCorpusSegment = ({
  segments = [],
  segmentCompatibility = [],
  measurementIdentityAvailable = false,
  strictMinPoints = CONFIRMED_STRICT_MIN_POINTS,
} = {}) => {
  const latestStrictIndex = segmentCompatibility.findLastIndex(
    (mode, index) =>
      mode === "strict" && segments[index]?.length >= strictMinPoints,
  );
  const longestIndex = segments.reduce(
    (best, segment, index) =>
      best < 0 || segment.length > segments[best].length ? index : best,
    -1,
  );
  const longestLegacyIndex = segments.reduce(
    (best, segment, index) =>
      segmentCompatibility[index] === "legacy" &&
      (best < 0 || segment.length > segments[best].length)
        ? index
        : best,
    -1,
  );
  return {
    index:
      latestStrictIndex >= 0
        ? latestStrictIndex
        : measurementIdentityAvailable && longestLegacyIndex >= 0
          ? longestLegacyIndex
          : longestIndex,
    mode:
      latestStrictIndex >= 0
        ? "strict"
        : measurementIdentityAvailable && longestLegacyIndex >= 0
          ? "legacy-fallback"
          : measurementIdentityAvailable
            ? "strict-insufficient"
            : "legacy",
  };
};
