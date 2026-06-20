import { FieldKeyType, FieldType } from "@teable/core";
import {
  createRecords,
  createTable,
  getFields,
  getRecords,
} from "../../../utils/init-app";
import { forEachRecordPage } from "../record-page-scan";

// Foreign fixture table shape shared by the link-aware runners
// (record-update-link, field-convert-link). The first field is the primary
// field, so its value is the link cell title.
export const FOREIGN_KEY_FIELD = "Key";
export const FOREIGN_NOTE_FIELD = "Note";

export type LinkPermutation = {
  multiplier: number;
  offset: number;
};

export type ForeignTableSeed = {
  tableId: string;
  tableName: string;
  keyFieldId: string;
};

const padRowNumber = (rowNumber: number) => String(rowNumber).padStart(6, "0");

const chunk = <T>(items: T[], size: number) => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};

// Deterministic mapping host row -> foreign row. The permutation keeps the
// mapping computable from the row number so V1/V2 runs and reruns compare.
export const foreignRowForHostRow = (
  hostRowNumber: number,
  foreignRowCount: number,
  permutation: LinkPermutation,
) =>
  (((hostRowNumber - 1) * permutation.multiplier + permutation.offset) %
    foreignRowCount) +
  1;

// The foreign primary title for a given foreign row; also the expected link
// cell title and the seeded text value for text-to-link conversion.
export const expectedForeignTitle = (
  foreignRowNumber: number,
  keyPrefix: string,
) => `${keyPrefix}-${padRowNumber(foreignRowNumber)}`;

type SeedFieldVo = { id: string; name: string; type?: string };

// Build the foreign table with deterministic, unique primary titles. Returns
// the primary key field id so callers can resolve titles back to record ids.
export const seedForeignTable = async (
  baseId: string,
  foreignTableName: string,
  options: { rowCount: number; batchSize: number; keyPrefix: string },
): Promise<ForeignTableSeed> => {
  const table = await createTable(baseId, {
    name: foreignTableName,
    fields: [
      { name: FOREIGN_KEY_FIELD, type: FieldType.SingleLineText },
      { name: FOREIGN_NOTE_FIELD, type: FieldType.SingleLineText },
    ],
    records: [],
  });

  const records = Array.from({ length: options.rowCount }, (_, index) => {
    const rowNumber = index + 1;
    return {
      fields: {
        [FOREIGN_KEY_FIELD]: expectedForeignTitle(rowNumber, options.keyPrefix),
        [FOREIGN_NOTE_FIELD]: `${options.keyPrefix}-note-${padRowNumber(
          rowNumber,
        )}`,
      },
    };
  });
  for (const batch of chunk(records, options.batchSize)) {
    const response = await createRecords(table.id, {
      fieldKeyType: FieldKeyType.Name,
      typecast: true,
      records: batch,
    });
    expect(response.records).toHaveLength(batch.length);
  }

  return {
    tableId: table.id,
    tableName: table.name,
    keyFieldId: resolveForeignKeyFieldId(
      (await getFields(table.id)) as SeedFieldVo[],
      foreignTableName,
    ),
  };
};

export const resolveForeignKeyFieldId = (
  foreignFields: SeedFieldVo[],
  foreignTableName: string,
) => {
  const keyField = foreignFields.find(
    (field) => field.name === FOREIGN_KEY_FIELD,
  );
  if (!keyField) {
    throw new Error(
      `Foreign table ${foreignTableName} is missing field ${FOREIGN_KEY_FIELD}`,
    );
  }
  return keyField.id;
};

// Map foreign primary title -> record id by scanning the foreign table. Using
// titles (not creation order) keeps the resolution robust regardless of the
// foreign view's default ordering.
export const fetchForeignIdByTitle = async (
  foreignTableId: string,
  keyFieldId: string,
  rowCount: number,
  pageSize = 1_000,
): Promise<Map<string, string>> => {
  const idByTitle = new Map<string, string>();
  await forEachRecordPage(
    {
      totalRows: rowCount,
      pageSize,
      fetchPage: (skip, take) =>
        getRecords(foreignTableId, {
          fieldKeyType: FieldKeyType.Id,
          projection: [keyFieldId],
          skip,
          take,
        }),
    },
    (record) => {
      const title = record.fields[keyFieldId];
      if (typeof title === "string") {
        idByTitle.set(title, record.id);
      }
    },
  );
  if (idByTitle.size !== rowCount) {
    throw new Error(
      `Foreign table ${foreignTableId} resolved ${idByTitle.size} titled rows, expected ${rowCount}`,
    );
  }
  return idByTitle;
};
