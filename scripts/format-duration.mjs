// Compact duration rendering shared by the report-stage projections.
//
// Three modules grew their own `XmSSs` formatter. Two of them rounded the total
// seconds before splitting into minutes; the third (the Feishu summary) split
// first and rounded the remainder, so a duration that rounds up through a
// minute boundary rendered as "1m60s" (119,700 ms) or "59m60s" (3,599,600 ms).
//
// Rounding the total first is the only ordering that cannot emit a 60-second
// remainder. Callers that need a sign, a null rendering, a sub-second tier, or
// an input assertion wrap this rather than reimplement it.

export const formatCompactDuration = (durationMs) => {
  const totalSeconds = Math.round(durationMs / 1_000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes > 0) {
    return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  }
  return `${seconds}s`;
};
