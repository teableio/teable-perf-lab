import { getTrashItems, TableTrashType, TrashType } from "@teable/openapi";

export type RecordTrashLookup = {
  trashId: string;
  resourceCount: number;
  deletedTime?: string;
  scannedPages: number;
};

const MAX_TRASH_PAGES = 25;

// `resourceIds` on a table trash item is a *preview*, not the batch.
//
// teable-ee 798c74478 capped it at the first 20 ids and moved the real size to
// `totalResourceCount`, because a bulk deletion can reference tens of thousands
// of resources. Counting `resourceIds` therefore stalls at 20 per item forever:
// run 30823883476 failed record-restore/restore-{1k,10k,50k} and
// record-delete/delete-stream-10k on both engines with coverage 20/1000,
// 20/10000 and 40/50000 — the 40 being two setup batches, not two records.
//
// Coverage is summed from `totalResourceCount` instead, and the preview is used
// only to decide whether an item belongs to this deletion.
//
// The give-up message carries a scan trace on purpose. `Record trash items
// cover 20/10000` cannot distinguish the three ways this scan stops — the page
// cap, the cursor running out, an empty page — and says nothing about what the
// preview-membership filter dropped on the way:
//
// - `stopped on no-cursor` after one page means the list really was that
//   short, so look at the writer, not at this scan.
// - `stopped on page-cap` means MAX_TRASH_PAGES is the binding constraint.
// - a non-zero `mixed-batch ... covering N expected records` means the
//   membership filter is hiding matches, and N is how many previewed ids it
//   hid (a lower bound on the batch, which the preview cannot size).
export const findRecordTrashItems = async (
  tableId: string,
  deletedRecordIds: string[],
): Promise<RecordTrashLookup[]> => {
  const expectedIds = new Set(deletedRecordIds);
  const seenTrashIds = new Set<string>();
  const lookups: RecordTrashLookup[] = [];
  let coveredCount = 0;
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
      totalResourceCount?: number;
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
      const previewIds = item.resourceIds;
      if (!previewIds.every((recordId) => expectedIds.has(recordId))) {
        // A batch whose preview mixes this deletion's records with other ids is
        // dropped whole. Count what its preview would have covered so the loss
        // stays visible.
        mixedBatchCount += 1;
        mixedBatchOverlap += previewIds.filter((recordId) =>
          expectedIds.has(recordId),
        ).length;
        continue;
      }
      if (seenTrashIds.has(item.id)) continue;
      seenTrashIds.add(item.id);
      // The preview is a floor on the batch: fall back to it only if a server
      // predating the `totalResourceCount` field omits the count.
      const resourceCount = item.totalResourceCount ?? previewIds.length;
      coveredCount += resourceCount;
      lookups.push({
        trashId: item.id,
        resourceCount,
        deletedTime: item.deletedTime,
        scannedPages: page,
      });
    }
    if (coveredCount >= expectedIds.size) {
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
    `Record trash items cover ${coveredCount}/${expectedIds.size} deleted records in table ${tableId} ` +
      `(scanned ${scannedPages}/${MAX_TRASH_PAGES} pages, stopped on ${stopReason}; ` +
      `${recordItemCount}/${seenItemCount} record trash items; ` +
      `${mixedBatchCount} mixed-batch items skipped covering ${mixedBatchOverlap} expected records)`,
  );
};
