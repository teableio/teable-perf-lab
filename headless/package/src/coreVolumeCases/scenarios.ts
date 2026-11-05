export type CoreVolumeConfig = {
  readonly rowCount: number;
  readonly batchSize: number;
  readonly queryPageSize: number;
};

export const CORE_VOLUME_CASE_ID_VERSION = 2;
export const CORE_VOLUME_BUCKET_COUNT = 10;
export const CORE_VOLUME_UPDATE_BUCKET = 0;
export const CORE_VOLUME_DELETE_BUCKET = 1;

/**
 * CI exercises five-digit volume; the opt-in large profile exercises six-digit
 * volume. Custom profiles retain their actual dimensions and are never renamed
 * to either named profile.
 */
export const CORE_VOLUME_PROFILES = {
  ci: { rowCount: 10_000, batchSize: 500, queryPageSize: 500 },
  large: { rowCount: 100_000, batchSize: 1_000, queryPageSize: 1_000 },
} as const satisfies Readonly<Record<string, CoreVolumeConfig>>;

export type CoreVolumeProfileName = keyof typeof CORE_VOLUME_PROFILES;
export type CoreVolumeProfileSelection =
  | CoreVolumeProfileName
  | Readonly<Partial<CoreVolumeConfig>>;

export type ResolvedCoreVolumeProfile = CoreVolumeConfig & {
  readonly profile: CoreVolumeProfileName | 'custom';
};

const assertIntegerInRange = (
  name: string,
  value: number,
  minimum: number,
  maximum: number
): void => {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
};

export function resolveCoreVolumeProfile(
  selection?: CoreVolumeProfileSelection
): ResolvedCoreVolumeProfile {
  if (typeof selection === 'string' && !(selection in CORE_VOLUME_PROFILES)) {
    throw new Error(`Unknown Core volume profile: ${selection}`);
  }
  const profile = typeof selection === 'string' ? selection : selection ? 'custom' : 'ci';
  const config =
    typeof selection === 'string'
      ? CORE_VOLUME_PROFILES[selection]
      : { ...CORE_VOLUME_PROFILES.ci, ...selection };

  assertIntegerInRange('profile.rowCount', config.rowCount, 2, Number.MAX_SAFE_INTEGER);
  assertIntegerInRange('profile.batchSize', config.batchSize, 1, 5_000);
  assertIntegerInRange('profile.queryPageSize', config.queryPageSize, 1, 1_000);
  return { profile, ...config };
}

export function coreVolumeCaseId(config: CoreVolumeConfig): string {
  return `headless-core-volume-cases-v${CORE_VOLUME_CASE_ID_VERSION}-${config.rowCount}r-${config.batchSize}b-${config.queryPageSize}q`;
}

export type CoreVolumeSegment = 'update' | 'delete' | 'control';
export type DeterministicVolumeRow = {
  readonly name: string;
  readonly segment: CoreVolumeSegment;
  readonly status: 'seed';
  readonly amount: number;
  readonly guard: string;
};

export const segmentForIndex = (index: number): CoreVolumeSegment => {
  const bucket = index % CORE_VOLUME_BUCKET_COUNT;
  if (bucket === CORE_VOLUME_UPDATE_BUCKET) return 'update';
  if (bucket === CORE_VOLUME_DELETE_BUCKET) return 'delete';
  return 'control';
};

export const deterministicVolumeRow = (index: number): DeterministicVolumeRow => ({
  name: `row-${index.toString().padStart(8, '0')}`,
  segment: segmentForIndex(index),
  status: 'seed',
  amount: index * 3 + 7,
  guard: `guard-${(index % 97).toString().padStart(2, '0')}-${index.toString().padStart(8, '0')}`,
});

export const volumeBucketCount = (rowCount: number, bucket: number): number => {
  if (rowCount <= bucket) return 0;
  return Math.floor((rowCount - 1 - bucket) / CORE_VOLUME_BUCKET_COUNT) + 1;
};

export const expectedVolumeCounts = (rowCount: number) => {
  const update = volumeBucketCount(rowCount, CORE_VOLUME_UPDATE_BUCKET);
  const deleted = volumeBucketCount(rowCount, CORE_VOLUME_DELETE_BUCKET);
  return {
    update,
    delete: deleted,
    control: rowCount - update - deleted,
    remaining: rowCount - deleted,
  } as const;
};
