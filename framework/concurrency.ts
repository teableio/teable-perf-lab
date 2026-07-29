// Bounded-parallelism map.
//
// Both the trace collector (fetching traces from Jaeger) and the publish script
// (posting them back) had their own byte-identical copy of this index-cursor
// worker pool. Neither is hot enough to justify a dependency, but two copies of
// a shared-mutable-cursor loop is two places to get the cursor wrong.
//
// Results keep input order regardless of completion order. `concurrency` is
// clamped to the item count, so an empty list spawns no workers.

export const runWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> => {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex;
        nextIndex += 1;
        results[currentIndex] = await fn(items[currentIndex]);
      }
    }),
  );

  return results;
};
