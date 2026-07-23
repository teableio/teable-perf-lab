import { shouldRestoreSharedMutableSeed } from "./record-mutation-lifecycle";

export const cleanupDeletedRecordSeed = async ({
  reusableSeed,
  executeDbIsolated,
  sharedSeedIdentity,
  canRestoreSeed = true,
  restoreSeed,
  deleteFixture,
}: {
  reusableSeed: boolean;
  executeDbIsolated: boolean;
  sharedSeedIdentity: boolean;
  canRestoreSeed?: boolean;
  restoreSeed: () => Promise<unknown>;
  deleteFixture: () => Promise<unknown>;
}) => {
  const restoreSharedSeed = shouldRestoreSharedMutableSeed({
    reusableSeed,
    executeDbIsolated,
    sharedSeedIdentity,
  });
  if (restoreSharedSeed) {
    if (!canRestoreSeed) {
      await deleteFixture();
      return;
    }
    try {
      await restoreSeed();
      return;
    } catch (restoreError) {
      try {
        await deleteFixture();
      } catch (deleteError) {
        throw new AggregateError(
          [restoreError, deleteError],
          "Failed to restore or delete the record trash seed fixture",
        );
      }
      throw restoreError;
    }
  }
  if (!executeDbIsolated) {
    await deleteFixture();
  }
};
