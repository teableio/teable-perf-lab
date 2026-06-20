// Paged full-scan over a table's records.
//
// Verification and readiness checks repeatedly scan an entire table one page at
// a time: page through getRecords, assert each page came back the size that was
// asked for, and walk every record by its 1-based row number. That skip/take
// shell — and the per-page bounds guard ("expected N at skip X") — was
// open-coded in ~20 runners, so an off-by-one in the take math or the page
// bound had ~20 places to hide.
//
// forEachRecordPage owns the shell once. Each caller keeps everything
// case-specific: how it fetches a page (projection, view, filter), what it
// checks per record, which samples it collects, its own final-count guard, and
// its own return shape. The iterator only yields (record, rowNumber) and
// reports how many records and pages it scanned.
//
// Deliberately NOT a universal validator: it does not collect samples or build
// a uniform {scannedRecords, verifiedSamples} result — that would just relocate
// each runner's divergent verification behind a wide config object.

export type ScannedRecord = { id: string; fields: Record<string, unknown> };

export const forEachRecordPage = async <TRecord extends ScannedRecord>(
  options: {
    totalRows: number;
    pageSize: number;
    fetchPage: (skip: number, take: number) => Promise<{ records: TRecord[] }>;
    // Noun used in the per-page size-mismatch error: "records" (default),
    // "pasted records", "duplicated rows", etc. Keep each caller's original
    // wording so the failure message is unchanged.
    pageNoun?: string;
  },
  onRecord: (record: TRecord, rowNumber: number) => void | Promise<void>,
): Promise<{ scannedRecords: number; pageCount: number }> => {
  const { totalRows, pageSize, fetchPage, pageNoun = "records" } = options;
  let scannedRecords = 0;
  let pageCount = 0;

  for (let skip = 0; skip < totalRows; skip += pageSize) {
    const expectedTake = Math.min(pageSize, totalRows - skip);
    const result = await fetchPage(skip, expectedTake);
    pageCount += 1;

    if (result.records.length !== expectedTake) {
      throw new Error(
        `Expected ${expectedTake} ${pageNoun} at skip ${skip}, got ${result.records.length}`,
      );
    }

    for (const [index, record] of result.records.entries()) {
      const rowNumber = skip + index + 1;
      await onRecord(record, rowNumber);
      scannedRecords += 1;
    }
  }

  return { scannedRecords, pageCount };
};
