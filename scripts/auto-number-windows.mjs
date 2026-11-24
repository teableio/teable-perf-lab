// Walk a Teable table in `__auto_number` windows.
//
// The performance-track table passed 700k rows in November 2026, and Teable's
// SQL endpoint cancels a statement after a few seconds. Anything that scans the
// whole table — a DISTINCT over one column, or a GROUP BY re-run for every
// LIMIT/OFFSET page — now times out every night, which is why the change point
// card stopped arriving (run 45302740609: "canceling statement due to statement
// timeout" while listing refs).
//
// `__auto_number` is indexed, so `MAX(...)` and a bounded range are cheap: a
// 50k-row window answers in under two seconds. Callers run their query once per
// window and merge the results themselves.

export const DEFAULT_WINDOW_ROWS = 50_000;
const MIN_WINDOW_ROWS = 1_000;

const STATEMENT_TIMEOUT = /statement timeout/i;

export const autoNumberColumn = `"__auto_number"`;

export const autoNumberRange = ({ from, to }) =>
  `${autoNumberColumn} > ${Math.floor(from)} AND ${autoNumberColumn} <= ${Math.floor(to)}`;

export const readMaxAutoNumber = async ({ query, table }) => {
  const rows = await query(
    `SELECT MAX(${autoNumberColumn}) AS m FROM ${table}`,
  );
  const max = Number(rows?.[0]?.m ?? 0);
  if (!Number.isFinite(max) || max < 0) {
    throw new Error(`Could not read MAX(__auto_number) from ${table}`);
  }
  return max;
};

/**
 * Call `visit({ from, to })` for consecutive windows covering (0, max].
 *
 * A window that still hits the statement timeout is split in half and retried,
 * down to MIN_WINDOW_ROWS, so a burst of unusually wide rows narrows the walk
 * instead of failing it.
 */
export const forEachAutoNumberWindow = async ({
  max,
  windowRows = DEFAULT_WINDOW_ROWS,
  visit,
}) => {
  let size = Math.max(MIN_WINDOW_ROWS, Math.floor(windowRows));
  let from = 0;
  while (from < max) {
    const to = Math.min(max, from + size);
    try {
      await visit({ from, to });
    } catch (error) {
      const reported = `${error?.teableError ?? ""} ${error?.message ?? ""}`;
      if (STATEMENT_TIMEOUT.test(reported) && size > MIN_WINDOW_ROWS) {
        size = Math.max(MIN_WINDOW_ROWS, Math.floor(size / 2));
        continue;
      }
      throw error;
    }
    from = to;
  }
};

/**
 * PostgreSQL `percentile_disc(fraction) WITHIN GROUP (ORDER BY v)`: the first
 * value whose cumulative distribution reaches `fraction`.
 */
export const percentileDisc = (values, fraction) => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(fraction * sorted.length) - 1);
  return sorted[index];
};
