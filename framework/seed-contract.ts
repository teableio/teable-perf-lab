export type SeedAffinityCase = {
  id: string;
  seedAffinity?: string;
};

export const resolveSeedIdentityCaseId = (
  perfCase: SeedAffinityCase,
  fallbackCaseId = perfCase.id,
) =>
  perfCase.seedAffinity
    ? `seed-affinity/${perfCase.seedAffinity}`
    : fallbackCaseId;
