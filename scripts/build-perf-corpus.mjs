// Land the whole Performance Track history as one local corpus.
//
// Every layer downstream — the noise model, the fast check, change point
// detection, the ledger — reads this file instead of querying Teable. One
// place that knows how to turn 143,350 rows into per-case series, and one
// place to fix when that turns out to be wrong.
//
// Three constraints shape how the read is done:
//
//   - The SQL endpoint caps a response at 50,000 characters, so the history
//     cannot arrive in one answer. It is aggregated server-side to one value
//     per case, engine and teable-ee commit, then paged.
//   - Aggregating in SQL rather than fetching rows and reducing locally. The
//     unaggregated read is 143,350 rows of which the long-text columns alone
//     would be hundreds of megabytes.
//   - Commit SHAs are sent abbreviated to 12 characters and re-expanded here
//     against the ordering and digest artifacts. At full length they were more
//     than half the payload, which is more than half the page count.
//
// Ordering, collapsing and segmentation are not done here — that is
// `commit-order-model.mjs`, which this script feeds.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { env } from "./env.mjs";
import { SUBSTITUTED_METRICS } from "./corpus-metric-model.mjs";
import {
  buildOrderedSeries,
  isPinnedCommit,
  segmentSeries,
} from "./commit-order-model.mjs";

export const PERF_CORPUS_FILE_NAME = "perf-corpus.json";

const execFileAsync = promisify(execFile);

const DEFAULT_ENDPOINT = "https://app.teable.ai";
const DEFAULT_BASE_ID = "bselS3I2MeVI6RJhS4g";
const DEFAULT_TABLE = "tblwPqrcchUzvyEOqLo";

// Rows per page. Sized so a page stays clear of the 50,000-character cap with
// the abbreviated SHAs above; the loop halves it and retries if a page is ever
// rejected, so the constant is a starting point rather than a promise.
const DEFAULT_PAGE_SIZE = 400;

// A hundred-odd pages over a few minutes will meet a dropped socket or a
// gateway hiccup. These are worth retrying; a rejected query is not, and
// retrying one would just repeat a mistake more slowly.
const TRANSIENT =
  /socket disconnected|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|502|503|504/i;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const unwrap = (data) => {
  if (data?.success === false) {
    const error = new Error(data.error ?? "unknown SQL error");
    error.teableError = data.error ?? "";
    throw error;
  }
  return data?.rows ?? [];
};

/**
 * Two transports for the same query.
 *
 * CI has a service token and talks to the API. A developer's machine usually
 * does not, but has the `teable` CLI already signed in — and a corpus rebuild is
 * exactly the thing someone wants to run locally before trusting a result. The
 * alternative, minting a personal token to run a read-only script, is worse for
 * everybody.
 */
const sqlQuery = async ({ endpoint, token, baseId, sql }) => {
  if (token) {
    // POST with the statement in the body, not GET with it in the query
    // string. The GET form does not exist and answers 404 — which only ever
    // showed up in CI, because a developer machine has no service token and
    // takes the CLI path below instead. The API path had never once run.
    const res = await fetch(
      `${endpoint.replace(/\/+$/, "")}/api/base/${baseId}/sql-query`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ sql }),
      },
    );
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`Teable SQL failed: ${res.status} ${text}`);
    }
    return unwrap(JSON.parse(text));
  }

  const { stdout } = await execFileAsync(
    "teable",
    ["sql-query", "--base-id", baseId, "--sql", sql],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return unwrap(JSON.parse(stdout));
};

/**
 * One row per case, engine and teable-ee commit, valued at the median of
 * however many runs measured it.
 *
 * Only passing measurements with a usable number. A failure has a duration, but
 * it is the duration of a failure, and feeding it into a series would show a
 * regression where there was an outage.
 *
 * `perf` is the perf-lab commit the measurement was taken at, which is what the
 * digest lookup keys on — a case's workload is defined by this repo, not by the
 * teable-ee commit under test. Where several perf-lab commits measured the same
 * teable-ee commit they arrive as separate rows and are reconciled below.
 *
 * A few cases have a primary metric that is a clamped difference of two
 * measurements and cannot carry a history; the inner select swaps in the
 * component `corpus-metric-model.mjs` names, and records the substituted metric
 * so a reader can see which number is in the series. Substituting inside the
 * subquery rather than after it puts the swap ahead of both the `> 0` filter
 * and the median, which is the point: the readings the clamp floored at zero
 * are usable once the difference is gone.
 */
const substitution = (column) => {
  const cases = [...SUBSTITUTED_METRICS].map(
    ([from, to]) =>
      `WHEN "Primary_Metric" = '${from}' THEN ${
        column === "metric"
          ? `'${to}'`
          : `("Metrics_JSON"::jsonb->>'${to}')::numeric`
      }`,
  );
  const fallback =
    column === "metric" ? `"Primary_Metric"` : `"Primary_Metric_Value"`;
  return cases.length === 0
    ? fallback
    : `CASE ${cases.join(" ")} ELSE ${fallback} END`;
};

const pageQuery = ({ table, limit, offset }) => `
  SELECT c, e, r, p, m,
         percentile_disc(0.5) WITHIN GROUP (ORDER BY v) AS v,
         COUNT(*) AS n
  FROM (
    SELECT "Case_ID" AS c,
           "Engine" AS e,
           LEFT("Teable_EE_Ref", 12) AS r,
           LEFT("Commit_SHA", 12) AS p,
           ${substitution("metric")} AS m,
           ${substitution("value")} AS v
    FROM ${table}
    WHERE "Status" = 'pass'
      AND "Engine" <> 'seed'
      AND LENGTH("Teable_EE_Ref") = 40
  ) t
  WHERE v > 0
  GROUP BY 1, 2, 3, 4, 5
  ORDER BY 1, 2, 3, 4
  LIMIT ${limit} OFFSET ${offset}`;

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

/**
 * Map an abbreviated SHA back to the full one, using the keys of an artifact
 * that already holds full SHAs.
 *
 * A 12-character prefix collides at roughly one in 10^14 over a few thousand
 * commits, but a collision would silently mis-position a measurement, so it is
 * detected rather than assumed away.
 *
 * Only real SHAs are indexed. `excluded` also holds the branch names recorded
 * as unpinned refs, and those genuinely collide — `perf/v2-cond` is the first
 * twelve characters of two different branches. They can never be looked up
 * anyway, since the query only returns rows whose ref is 40 characters.
 */
const prefixIndex = (fullShas) => {
  const index = new Map();
  for (const sha of fullShas.filter((value) => isPinnedCommit(value))) {
    const prefix = sha.slice(0, 12);
    if (index.has(prefix) && index.get(prefix) !== sha) {
      throw new Error(
        `Abbreviated SHA ${prefix} matches both ${index.get(prefix)} and ${sha}; widen the abbreviation.`,
      );
    }
    index.set(prefix, sha);
  }
  return index;
};

const main = async () => {
  const token = env("TEABLE_PERF_LAB_TOKEN");
  const endpoint = env("TEABLE_ENDPOINT", DEFAULT_ENDPOINT);
  const baseId = env("TEABLE_PERF_LAB_BASE_ID", DEFAULT_BASE_ID);
  const table = `"${baseId}"."${env("TEABLE_PERF_LAB_TABLE_ID", DEFAULT_TABLE)}"`;
  const outputPath = resolve(env("PERF_CORPUS_PATH", PERF_CORPUS_FILE_NAME));

  const order = await readJson(
    resolve(env("COMMIT_ORDER_PATH", "commit-order.json")),
  );
  const digests = await readJson(
    resolve(env("CASE_DIGESTS_PATH", "case-digests.json")),
  );

  const eeIndex = prefixIndex([
    ...Object.keys(order.ordinals),
    ...Object.keys(order.excluded),
  ]);
  const perfIndex = prefixIndex(Object.keys(digests.byCommit));

  const rows = [];
  let pageSize = Number(
    env("PERF_CORPUS_PAGE_SIZE", String(DEFAULT_PAGE_SIZE)),
  );
  let offset = 0;
  for (;;) {
    let page;
    let attempt = 0;
    for (;;) {
      try {
        page = await sqlQuery({
          endpoint,
          token,
          baseId,
          sql: pageQuery({ table, limit: pageSize, offset }),
        });
        break;
      } catch (error) {
        const reported = `${error.teableError ?? ""} ${error.message ?? ""}`;
        // The cap is reported as an error, not a truncation, so a page that is
        // too wide is retried narrower rather than silently losing its tail.
        if (pageSize > 25 && /exceeds the limit/.test(reported)) {
          pageSize = Math.floor(pageSize / 2);
          continue;
        }
        attempt += 1;
        if (attempt > 5 || !TRANSIENT.test(reported)) {
          throw new Error(
            `Page at offset ${offset} failed after ${attempt} attempt(s): ${reported.trim()}`,
          );
        }
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
    rows.push(...page);
    if (page.length < pageSize) break;
    offset += page.length;
    if (rows.length % 4000 === 0) {
      console.log(`  ${rows.length} rows…`);
    }
  }

  // Expand the abbreviations, and record what the digest was at the perf-lab
  // commit that took each measurement.
  const expanded = [];
  let unknownEe = 0;
  for (const row of rows) {
    const commit = eeIndex.get(row.r);
    if (!commit) {
      unknownEe += 1;
      continue;
    }
    const perfSha = perfIndex.get(row.p);
    const snapshot =
      perfSha === undefined
        ? undefined
        : digests.snapshots[digests.byCommit[perfSha]];
    expanded.push({
      caseId: row.c,
      engine: row.e,
      commit,
      metric: row.m,
      value: Number(row.v),
      result: "pass",
      runId: String(row.n),
      digest: snapshot?.[row.c],
    });
  }

  const { series, dropped } = buildOrderedSeries({
    rows: expanded,
    ordinals: order.ordinals,
    excluded: order.excluded,
  });

  // The digest belongs to the measurement, not to the teable-ee commit, so it
  // is carried on the expanded rows and re-attached here by (case, commit).
  const digestByPoint = new Map();
  for (const row of expanded) {
    const key = `${row.caseId}::${row.engine}::${row.commit}`;
    if (!digestByPoint.has(key)) {
      digestByPoint.set(key, new Set());
    }
    digestByPoint.get(key).add(row.digest);
  }

  const out = {};
  let cut = 0;
  for (const [key, entry] of series) {
    const digestAt = (commit) => {
      const seen = digestByPoint.get(
        `${entry.caseId}::${entry.engine}::${commit}`,
      );
      // One commit measured under two different workloads is not comparable
      // with either neighbour, so it reads as unknown and cuts the series.
      return seen && seen.size === 1 ? [...seen][0] : undefined;
    };
    const segments = segmentSeries(entry.points, { digestAt });
    if (segments.length > 1) cut += 1;
    out[key] = {
      caseId: entry.caseId,
      engine: entry.engine,
      // What number is in here. Without it the standing list cannot tell a
      // duration from a clamped difference, and the guard that refuses one
      // reads `undefined` and passes everything.
      metric: entry.metric,
      segments: segments.map((segment) =>
        segment.map((point) => [point.ordinal, point.value, point.runs]),
      ),
    };
  }

  const lengths = Object.values(out)
    .map((entry) =>
      Math.max(...entry.segments.map((segment) => segment.length)),
    )
    .sort((a, b) => a - b);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify({
      rowCount: rows.length,
      seriesCount: Object.keys(out).length,
      dropped: { ...dropped, unknownEeRef: unknownEe },
      series: out,
    })}\n`,
  );

  console.log(
    `Perf corpus: ${rows.length} aggregated rows → ${Object.keys(out).length} series ` +
      `(${cut} cut by workload change); longest segment median ${lengths[lengths.length >> 1]}, ` +
      `p10 ${lengths[Math.floor(lengths.length * 0.1)]}; dropped ${JSON.stringify({ ...dropped, unknownEeRef: unknownEe })} → ${outputPath}`,
  );
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
