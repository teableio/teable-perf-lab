import { getTrashItems, TableTrashType, TrashType } from "@teable/openapi";

export type RecordTrashLookup = {
  trashId: string;
  resourceCount: number;
  deletedTime?: string;
  scannedPages: number;
};

export const findRecordTrashItems = async (
  tableId: string,
  deletedRecordIds: string[],
): Promise<RecordTrashLookup[]> => {
  const expectedIds = new Set(deletedRecordIds);
  const matchedIds = new Set<string>();
  const lookups: RecordTrashLookup[] = [];
  let cursor: string | null | undefined;
  for (let page = 1; page <= 25; page += 1) {
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
    for (const item of items) {
      if (
        item.resourceType !== TableTrashType.Record ||
        !item.resourceIds?.length ||
        !item.resourceIds.every((recordId) => expectedIds.has(recordId))
      ) {
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
    if (!cursor || items.length === 0) break;
  }

  throw new Error(
    `Record trash items cover ${matchedIds.size}/${expectedIds.size} deleted records in table ${tableId}`,
  );
};
