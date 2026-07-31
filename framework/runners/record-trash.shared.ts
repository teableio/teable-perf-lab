import { getTrashItems, TableTrashType, TrashType } from "@teable/openapi";

export type RecordTrashLookup = {
  trashId: string;
  resourceCount: number;
  deletedTime?: string;
  scannedPages: number;
};

const MAX_TRASH_PAGES = 25;

// The give-up message carries a scan trace on purpose.
//
// `Record trash items cover 20/10000` cannot distinguish the three ways this
// scan stops — the page cap, the cursor running out, an empty page — and says
// nothing about what the `resourceIds.every(...)` filter dropped on the way.
// Run 30600597922 failed five shards with coverage counts of 20, 40 and 200,
// and the message could not tell "paging stopped early" apart from "the trash
// rows genuinely were not written". The counters below make the next
// occurrence self-diagnosing instead of a guess:
//
// - `stopped on no-cursor` after one page means the list really was that
//   short, so look at the writer, not at this scan.
// - `stopped on page-cap` means MAX_TRASH_PAGES is the binding constraint.
// - a non-zero `mixed-batch ... covering N expected records` means the
//   every() filter is hiding matches, and N is how many it hid.
export const findRecordTrashItems = async (
  tableId: string,
  deletedRecordIds: string[],
): Promise<RecordTrashLookup[]> => {
  const expectedIds = new Set(deletedRecordIds);
  const matchedIds = new Set<string>();
  const lookups: RecordTrashLookup[] = [];
  let cursor: string | null | undefined;
  let scannedPages = 0;
  let stopReason: "page-cap" | "no-cursor" | "empty-page" = "page-cap";
  let seenItemCount = 0;
  let recordItemCount = 0;
  let mixedBatchCount = 0;
  let mixedBatchOverlap = 0;

  for (let page = 1; page <= MAX_TRASH_PAGES; page += 1) {
    scannedPages = page;
    const response = await getTrashItems({
      resourceId: tableId,
      resourceType: TrashType.Table,
      cursor,
    });
    const items = response.data.trashItems as Array<{
      id: string;
      resourceType?: string;
      resourceIds?: string[];
      deletedTime?: string;
    }>;
    seenItemCount += items.length;
    for (const item of items) {
      if (
        item.resourceType !== TableTrashType.Record ||
        !item.resourceIds?.length
      ) {
        continue;
      }
      recordItemCount += 1;
      if (!item.resourceIds.every((recordId) => expectedIds.has(recordId))) {
        // A batch mixing this deletion's records with other ids is dropped
        // whole. Count what it would have covered so the loss is visible.
        mixedBatchCount += 1;
        mixedBatchOverlap += item.resourceIds.filter((recordId) =>
          expectedIds.has(recordId),
        ).length;
        continue;
      }
      const newIds = item.resourceIds.filter(
        (recordId) => !matchedIds.has(recordId),
      );
      if (newIds.length === 0) continue;
      newIds.forEach((recordId) => matchedIds.add(recordId));
      lookups.push({
        trashId: item.id,
        resourceCount: item.resourceIds.length,
        deletedTime: item.deletedTime,
        scannedPages: page,
      });
    }
    if (matchedIds.size === expectedIds.size) {
      return lookups;
    }

    cursor = (response.data as { nextCursor?: string | null }).nextCursor;
    if (items.length === 0) {
      stopReason = "empty-page";
      break;
    }
    if (!cursor) {
      stopReason = "no-cursor";
      break;
    }
  }

  throw new Error(
    `Record trash items cover ${matchedIds.size}/${expectedIds.size} deleted records in table ${tableId} ` +
      `(scanned ${scannedPages}/${MAX_TRASH_PAGES} pages, stopped on ${stopReason}; ` +
      `${recordItemCount}/${seenItemCount} record trash items; ` +
      `${mixedBatchCount} mixed-batch items skipped covering ${mixedBatchOverlap} expected records)`,
  );
};
