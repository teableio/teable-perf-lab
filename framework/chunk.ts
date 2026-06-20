// Split an array into fixed-size batches, in order; the last batch may be
// shorter. The runners use it to break seed records into createRecords batches.
// It was copy-pasted, byte-identical, into ~20 runners.
export const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
};
