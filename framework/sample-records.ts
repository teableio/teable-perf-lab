// Seed-time verification samples.
//
// A runner can't re-read every row after the measured operation, so it picks a
// few row offsets (config.verify.sampleRows) and remembers their record ids
// while seeding; after the operation it re-reads exactly those rows to confirm
// the effect. Capturing the id of each wanted row during a seed batch was the
// same ~8-line forEach in five read/field runners, easy to copy with an
// off-by-one (input vs record index) or a typo'd map variable.
//
// This module owns only that capture step and the sample shape. The retrieval
// side (which offsets are required, the "missing sample" error) stays in each
// runner: it diverges (host vs source samples, recordCount vs rowCount wording)
// and that divergence is load-bearing.

export type SeededSampleRecord = {
  rowOffset: number;
  rowNumber: number;
  recordId: string;
};

// Record the id of each freshly-created record whose row offset is wanted as a
// verification sample. `inputs[i]` is the source row for `records[i]` (both in
// batch order); only offsets in `wanted` are kept, keyed by offset.
export const collectSampleRecords = (
  sampleByOffset: Map<number, SeededSampleRecord>,
  wanted: Set<number>,
  inputs: ReadonlyArray<{ rowOffset: number; rowNumber: number }>,
  records: ReadonlyArray<{ id: string }>,
): void => {
  records.forEach((record, index) => {
    const input = inputs[index];
    if (input && wanted.has(input.rowOffset)) {
      sampleByOffset.set(input.rowOffset, {
        rowOffset: input.rowOffset,
        rowNumber: input.rowNumber,
        recordId: record.id,
      });
    }
  });
};
