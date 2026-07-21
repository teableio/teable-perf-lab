import type { PerfCase } from "../types";

export const getStoredFieldDuplicateSeedIdentityCase = (
  perfCase: PerfCase,
  seedIdentity?: string,
) =>
  seedIdentity
    ? ({
        ...perfCase,
        id: `field-duplicate/shared-${seedIdentity}`,
      } as PerfCase)
    : perfCase;

export const getStoredFieldDuplicateSeedIdentity = (seedIdentity?: string) =>
  seedIdentity ? { seedIdentity } : undefined;
