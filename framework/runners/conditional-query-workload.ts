import type {
  ConditionalQueryCaseConfig,
  ConditionalQueryMutationConfig,
} from "../types";

export const CONDITIONAL_QUERY_SOURCE_FIELDS = [
  "A Group",
  "A Text",
  "A Amount",
  "A Active",
] as const;
export const CONDITIONAL_QUERY_HOST_FIELDS = ["B Key", "Lookup Group"] as const;

export type ConditionalQueryValuePhase = "seed" | "mutated";
export type ConditionalQueryPropagationCaseConfig = Extract<
  ConditionalQueryCaseConfig,
  { mutation: ConditionalQueryMutationConfig }
>;
export type ConditionalQuerySourceFieldIds = {
  group: string;
  text: string;
  amount: string;
  active: string;
};
export type ConditionalQueryMutationTarget = {
  recordId: string;
  group: number;
  slot: number;
};

type SeedRecord = { fields: Record<string, string | number | boolean> };
type SourcePosition = {
  group: number;
  slot: number;
  mutationTarget: boolean;
};
type WorkloadShape = {
  fanout: number;
  groupMatchesPerHost: number;
  retainedValuesPerHost: number;
  groupMatchPairCount: number;
  retainedValueCount: number;
};
type MutationWorkload = {
  recordsPerGroup: number;
  scanRows: number;
  fields: (
    sourceFields: ConditionalQuerySourceFieldIds,
    target: ConditionalQueryMutationTarget,
    phase: ConditionalQueryValuePhase,
  ) => Record<string, string | number | boolean>;
};

// The deterministic model behind every conditional-query case. Callers provide
// only a case config; this module owns the grouped-fanout algebra, seed rows,
// mutation targeting, and expected computed values as one deep in-process
// interface. Keeping these rules together prevents the runtime runner and its
// verification code from developing subtly different versions of the workload.
export type ConditionalQueryWorkload = {
  sourceRows: () => SeedRecord[];
  hostRows: () => SeedRecord[];
  sourceRow: (row: number) => SeedRecord;
  hostRow: (row: number) => SeedRecord;
  sourcePosition: (row: number) => SourcePosition;
  expectedValue: (
    hostRow: number,
    phase: ConditionalQueryValuePhase,
  ) => unknown;
  shape: (phase: ConditionalQueryValuePhase) => WorkloadShape;
  mutation?: MutationWorkload;
};

const assertConfig = (config: ConditionalQueryCaseConfig) => {
  const rowsPerGroup = config.sourceRecordCount / config.groupCount;
  if (config.sourceRecordCount % config.groupCount !== 0 || rowsPerGroup < 2) {
    throw new Error("Grouped fanout requires an integral fanout >= 2");
  }
  if (!config.mutation) return;
  if (
    !Number.isInteger(config.mutation.recordCount) ||
    config.mutation.recordCount <= 0 ||
    config.mutation.recordCount % config.groupCount !== 0
  ) {
    throw new Error(
      "Conditional query mutation recordCount must be a positive multiple of groupCount",
    );
  }
  const slotsPerGroup = config.mutation.recordCount / config.groupCount;
  const activeSlotsPerGroup = Math.ceil(rowsPerGroup / 2);
  if (config.mutation.kind === "text-update" && slotsPerGroup > rowsPerGroup) {
    throw new Error("Text mutation exceeds the available rows per group");
  }
  if (
    config.mutation.kind !== "text-update" &&
    slotsPerGroup > activeSlotsPerGroup
  ) {
    throw new Error("Active-row mutation exceeds the active rows per group");
  }
  if (
    config.mutation.kind === "text-update" &&
    !(config.field.kind === "lookup" && config.field.valueField === "text")
  ) {
    throw new Error("Text mutation requires a text lookup field");
  }
  if (
    config.mutation.kind === "amount-update" &&
    !(
      config.field.kind === "rollup" &&
      config.field.valueField === "amount" &&
      !config.field.sort
    )
  ) {
    throw new Error("Amount mutation requires an unsorted amount rollup field");
  }
  if (
    config.mutation.kind === "active-flip" &&
    !(
      config.field.kind === "lookup" &&
      config.field.valueField === "text" &&
      config.field.filter === "group-and-active"
    )
  ) {
    throw new Error(
      "Active mutation requires an active-filtered text lookup field",
    );
  }
};

export const createConditionalQueryWorkload = (
  config: ConditionalQueryCaseConfig,
): ConditionalQueryWorkload => {
  assertConfig(config);

  const rowsPerGroup = config.sourceRecordCount / config.groupCount;
  const groupKey = (group: number) =>
    `${config.generator.groupPrefix}-${group}`;
  const groupForHost = (row: number) =>
    (((row - 1) * config.generator.permutation.multiplier +
      config.generator.permutation.offset) %
      config.groupCount) +
    1;
  const mutationSlotsPerGroup = config.mutation
    ? config.mutation.recordCount / config.groupCount
    : 0;
  const isMutationTargetSlot = (slot: number) => {
    if (!config.mutation) return false;
    return config.mutation.kind === "text-update"
      ? slot <= mutationSlotsPerGroup
      : slot % 2 === 1 && slot <= mutationSlotsPerGroup * 2 - 1;
  };
  const isActiveSlot = (slot: number, phase: ConditionalQueryValuePhase) =>
    slot % 2 === 1 &&
    !(
      phase === "mutated" &&
      config.mutation?.kind === "active-flip" &&
      isMutationTargetSlot(slot)
    );
  const textValue = (
    group: number,
    slot: number,
    phase: ConditionalQueryValuePhase,
  ) => {
    const base = `${config.generator.sourceTextPrefix}-${group}-${slot}`;
    return phase === "mutated" &&
      config.mutation?.kind === "text-update" &&
      isMutationTargetSlot(slot)
      ? `${base}-${config.mutation.updatedSuffix}`
      : base;
  };
  const amountValue = (
    group: number,
    slot: number,
    phase: ConditionalQueryValuePhase,
  ) =>
    group * 100 +
    slot +
    (phase === "mutated" &&
    config.mutation?.kind === "amount-update" &&
    isMutationTargetSlot(slot)
      ? config.mutation.amountDelta
      : 0);
  const retainedValuesPerHost = (phase: ConditionalQueryValuePhase) => {
    const filtered = Array.from(
      { length: rowsPerGroup },
      (_, i) => i + 1,
    ).filter(
      (slot) => config.field.filter === "group" || isActiveSlot(slot, phase),
    ).length;
    return config.field.limit == null
      ? filtered
      : Math.min(filtered, config.field.limit);
  };
  const sourcePosition = (row: number): SourcePosition => {
    const group = ((row - 1) % config.groupCount) + 1;
    const slot = Math.floor((row - 1) / config.groupCount) + 1;
    return { group, slot, mutationTarget: isMutationTargetSlot(slot) };
  };
  const sourceRow = (row: number): SeedRecord => {
    const { group, slot } = sourcePosition(row);
    return {
      fields: {
        "A Group": groupKey(group),
        "A Text": textValue(group, slot, "seed"),
        "A Amount": amountValue(group, slot, "seed"),
        "A Active": isActiveSlot(slot, "seed"),
      },
    };
  };
  const hostRow = (row: number): SeedRecord => ({
    fields: {
      "B Key": `${config.generator.hostKeyPrefix}-${row}`,
      "Lookup Group": groupKey(groupForHost(row)),
    },
  });
  const expectedValue = (
    hostRowNumber: number,
    phase: ConditionalQueryValuePhase,
  ): unknown => {
    const group = groupForHost(hostRowNumber);
    const slots = Array.from({ length: rowsPerGroup }, (_, i) => i + 1).filter(
      (slot) => config.field.filter === "group" || isActiveSlot(slot, phase),
    );
    const ordered =
      config.field.sort?.order === "desc" ? [...slots].reverse() : slots;
    const limited = config.field.limit
      ? ordered.slice(0, config.field.limit)
      : ordered;
    if (config.field.kind === "lookup") {
      return config.field.valueField === "text"
        ? limited.map((slot) => textValue(group, slot, phase))
        : config.field.valueField === "amount"
          ? limited.map((slot) => amountValue(group, slot, phase))
          : limited.map((slot) => isActiveSlot(slot, phase));
    }
    if (config.field.expression === "countall({values})") {
      return limited.length;
    }
    const numbers = limited.map((slot) => amountValue(group, slot, phase));
    if (config.field.expression === "sum({values})") {
      return numbers.reduce((sum, value) => sum + value, 0);
    }
    if (config.field.expression === "average({values})") {
      return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
    }
    if (config.field.expression === "max({values})") {
      return Math.max(...numbers);
    }
    return limited.map((slot) => textValue(group, slot, phase)).join(", ");
  };

  const mutation: MutationWorkload | undefined = config.mutation
    ? {
        recordsPerGroup: mutationSlotsPerGroup,
        scanRows:
          (config.mutation.kind === "text-update"
            ? mutationSlotsPerGroup
            : mutationSlotsPerGroup * 2 - 1) * config.groupCount,
        fields: (sourceFields, target, phase) => {
          switch (config.mutation?.kind) {
            case "text-update":
              return {
                [sourceFields.text]: textValue(
                  target.group,
                  target.slot,
                  phase,
                ),
              };
            case "amount-update":
              return {
                [sourceFields.amount]: amountValue(
                  target.group,
                  target.slot,
                  phase,
                ),
              };
            case "active-flip":
              return {
                [sourceFields.active]: isActiveSlot(target.slot, phase),
              };
            default:
              throw new Error("Conditional query mutation workload is missing");
          }
        },
      }
    : undefined;

  return {
    sourceRows: () =>
      Array.from({ length: config.sourceRecordCount }, (_, i) =>
        sourceRow(i + 1),
      ),
    hostRows: () =>
      Array.from({ length: config.hostRecordCount }, (_, i) => hostRow(i + 1)),
    sourceRow,
    hostRow,
    sourcePosition,
    expectedValue,
    shape: (phase) => {
      const retained = retainedValuesPerHost(phase);
      return {
        fanout: rowsPerGroup,
        groupMatchesPerHost: rowsPerGroup,
        retainedValuesPerHost: retained,
        groupMatchPairCount: config.hostRecordCount * rowsPerGroup,
        retainedValueCount: config.hostRecordCount * retained,
      };
    },
    mutation,
  };
};
