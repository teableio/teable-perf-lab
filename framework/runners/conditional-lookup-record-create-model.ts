import type { ConditionalLookupRecordCreateCaseConfig } from "../types";

export type ConditionalLookupDirtyHostRow = {
  dirtyOffset: number;
  hostRowNumber: number;
  sourceRowNumber: number;
  hostKey: string;
  lookupKey: string;
  expectedValue: string;
};

export const assertConditionalLookupRecordCreateConfig = (
  config: ConditionalLookupRecordCreateCaseConfig,
) => {
  const { recordCount, mutation, verify } = config;
  if (!Number.isInteger(recordCount) || recordCount < 1) {
    throw new Error("Conditional lookup seed recordCount must be positive");
  }
  if (!Number.isInteger(mutation.recordCount) || mutation.recordCount < 1) {
    throw new Error("Conditional lookup dirty recordCount must be positive");
  }
  if (
    !Number.isInteger(mutation.sourceStartOffset) ||
    mutation.sourceStartOffset < 0 ||
    mutation.sourceStartOffset + mutation.recordCount > recordCount
  ) {
    throw new Error(
      `Conditional lookup dirty source window is out of range: offset=${mutation.sourceStartOffset}, count=${mutation.recordCount}, sourceRows=${recordCount}`,
    );
  }

  const dirtySamples = new Set<number>();
  for (const offset of verify.dirtySampleRows) {
    if (
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset >= mutation.recordCount
    ) {
      throw new Error(
        `Conditional lookup dirty sample offset ${offset} is out of range for ${mutation.recordCount} records`,
      );
    }
    if (dirtySamples.has(offset)) {
      throw new Error(
        `Conditional lookup dirty sample offset ${offset} is duplicated`,
      );
    }
    dirtySamples.add(offset);
  }
};

export const buildConditionalLookupDirtyHostRows = (
  config: ConditionalLookupRecordCreateCaseConfig,
): ConditionalLookupDirtyHostRow[] => {
  assertConditionalLookupRecordCreateConfig(config);
  return Array.from(
    { length: config.mutation.recordCount },
    (_, dirtyOffset) => {
      const hostRowNumber = config.recordCount + dirtyOffset + 1;
      const sourceRowNumber =
        config.mutation.sourceStartOffset + dirtyOffset + 1;
      return {
        dirtyOffset,
        hostRowNumber,
        sourceRowNumber,
        hostKey: `${config.generator.hostKeyPrefix}-${hostRowNumber}`,
        lookupKey: `${config.generator.sourceKeyPrefix}-${sourceRowNumber}`,
        expectedValue: `${config.generator.sourceValuePrefix}-${sourceRowNumber}`,
      };
    },
  );
};

export const lookupTextValues = (value: unknown): string[] => {
  if (typeof value === "string") {
    return [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (typeof item === "string") {
      return [item];
    }
    if (item && typeof item === "object" && "title" in item) {
      const title = (item as { title?: unknown }).title;
      return typeof title === "string" ? [title] : [];
    }
    return [];
  });
};
