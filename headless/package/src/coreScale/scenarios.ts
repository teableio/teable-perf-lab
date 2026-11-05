export type CoreScaleConfig = {
  readonly baseRows: number;
  readonly fanoutRows: number;
  readonly batchSize: number;
};

export const CORE_SCALE_BASELINE_AMOUNT = 7;
export const CORE_SCALE_TARGET_AMOUNT = 20;
export const CORE_SCALE_CASE_ID_VERSION = 1;

export function coreScaleCaseId(scale: CoreScaleConfig): string {
  return `headless-core-scale-computed-fanout-v${CORE_SCALE_CASE_ID_VERSION}-${scale.baseRows}r-${scale.fanoutRows}f-${scale.batchSize}b`;
}

/**
 * The CI profile is intentionally large enough to exercise physical paging and
 * four-digit computed fanout. The large profile is opt-in for workstation or
 * dedicated performance runs.
 */
export const CORE_SCALE_SCENARIOS = {
  ci: { baseRows: 10_000, fanoutRows: 1_000, batchSize: 500 },
  large: { baseRows: 100_000, fanoutRows: 10_000, batchSize: 1_000 },
} as const satisfies Readonly<Record<string, CoreScaleConfig>>;

export type CoreScaleSelection =
  | keyof typeof CORE_SCALE_SCENARIOS
  | Readonly<Partial<CoreScaleConfig>>;

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
};

export function resolveCoreScale(selection?: CoreScaleSelection): CoreScaleConfig {
  const resolved =
    typeof selection === 'string'
      ? CORE_SCALE_SCENARIOS[selection]
      : { ...CORE_SCALE_SCENARIOS.ci, ...selection };

  assertPositiveInteger('scale.baseRows', resolved.baseRows);
  assertPositiveInteger('scale.fanoutRows', resolved.fanoutRows);
  assertPositiveInteger('scale.batchSize', resolved.batchSize);
  if (resolved.batchSize > 1_000) {
    throw new Error('scale.batchSize must not exceed the core command limit of 1000');
  }
  return resolved;
}

export type DeterministicSourceRow = {
  readonly title: string;
  readonly amount: number;
};

export type DeterministicFanoutRow = {
  readonly title: string;
  readonly bucket: 'included';
};

export const deterministicSourceRow = (index: number): DeterministicSourceRow => ({
  title: `source-${index.toString().padStart(8, '0')}`,
  amount: index === 0 ? CORE_SCALE_BASELINE_AMOUNT : 100 + (index % 97),
});

export const deterministicFanoutRow = (index: number): DeterministicFanoutRow => ({
  title: `fanout-${index.toString().padStart(8, '0')}`,
  bucket: 'included',
});
