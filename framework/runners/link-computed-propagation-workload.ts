export type LinkComputedMutationWindowConfig = {
  startOffset?: number;
  recordCount: number;
};

export type LinkComputedMutationWindow = {
  startOffset: number;
  recordCount: number;
  endOffsetExclusive: number;
};

export type LinkComputedOrderMode = "first-link" | "repoint";
export type LinkComputedOrderPhase = "seed" | "updated";
export type LinkComputedPermutationPhase = "seed" | "updated";
export type LinkComputedReadPath = "full-scan" | "get-record" | "get-records";

const assertNonNegativeInteger = (name: string, value: number) => {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer, got ${value}`);
  }
};

export const resolveMutationWindow = (
  rowCount: number,
  mutation?: LinkComputedMutationWindowConfig,
): LinkComputedMutationWindow => {
  if (!Number.isInteger(rowCount) || rowCount <= 0) {
    throw new Error(`rowCount must be a positive integer, got ${rowCount}`);
  }
  const startOffset = mutation?.startOffset ?? 0;
  const recordCount = mutation?.recordCount ?? rowCount;
  assertNonNegativeInteger("mutation.startOffset", startOffset);
  if (!Number.isInteger(recordCount) || recordCount <= 0) {
    throw new Error(
      `mutation.recordCount must be a positive integer, got ${recordCount}`,
    );
  }
  const endOffsetExclusive = startOffset + recordCount;
  if (endOffsetExclusive > rowCount) {
    throw new Error(
      `mutation window [${startOffset}, ${endOffsetExclusive}) exceeds rowCount ${rowCount}`,
    );
  }
  return { startOffset, recordCount, endOffsetExclusive };
};

export const isMutatedOrderOffset = (
  rowCount: number,
  rowOffset: number,
  mutation?: LinkComputedMutationWindowConfig,
) => {
  assertNonNegativeInteger("rowOffset", rowOffset);
  if (rowOffset >= rowCount) {
    throw new Error(`rowOffset ${rowOffset} exceeds rowCount ${rowCount}`);
  }
  const window = resolveMutationWindow(rowCount, mutation);
  return (
    rowOffset >= window.startOffset && rowOffset < window.endOffsetExclusive
  );
};

export const expectedOrderState = ({
  mode,
  rowCount,
  mutation,
  phase,
  rowOffset,
}: {
  mode: LinkComputedOrderMode;
  rowCount: number;
  mutation?: LinkComputedMutationWindowConfig;
  phase: LinkComputedOrderPhase;
  rowOffset: number;
}): {
  linked: boolean;
  permutationPhase: LinkComputedPermutationPhase;
} => {
  if (phase === "seed") {
    return {
      linked: mode === "repoint",
      permutationPhase: "seed",
    };
  }
  if (isMutatedOrderOffset(rowCount, rowOffset, mutation)) {
    return { linked: true, permutationPhase: "updated" };
  }
  return {
    linked: mode === "repoint",
    permutationPhase: "seed",
  };
};

export const resolveReadinessPlan = (
  readPath: LinkComputedReadPath = "full-scan",
):
  | {
      primaryReadPath: "full-scan";
      verifyFullCascadeAfterPrimary: false;
    }
  | {
      primaryReadPath: Exclude<LinkComputedReadPath, "full-scan">;
      verifyFullCascadeAfterPrimary: true;
    } =>
  readPath === "full-scan"
    ? {
        primaryReadPath: "full-scan",
        verifyFullCascadeAfterPrimary: false,
      }
    : {
        primaryReadPath: readPath,
        verifyFullCascadeAfterPrimary: true,
      };
