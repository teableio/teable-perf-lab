export const getPositiveNumberEnv = (name: string) => {
  const parsed = Number.parseFloat(process.env[name] ?? "");
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export const getPositiveIntegerEnv = (name: string) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

export const getPrimaryThresholdMs = (fallback: number) =>
  getPositiveNumberEnv("PERF_LAB_PRIMARY_THRESHOLD_MS") ?? fallback;
