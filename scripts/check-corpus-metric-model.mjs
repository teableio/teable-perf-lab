import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  carriesDrift,
  corpusMetricName,
  corpusMetricRevision,
  corpusMetricValue,
  DIFFERENTIAL_METRICS,
  SUBSTITUTED_METRICS,
} from "./corpus-metric-model.mjs";

// --- which name the corpus records ------------------------------------------------

// An ordinary metric passes through untouched.
assert.equal(corpusMetricName("duplicateSingleP95Ms"), "duplicateSingleP95Ms");
assert.equal(corpusMetricName(undefined), undefined);

// A clamped difference is recorded under the component that replaced it, so a
// reader of the corpus can see which number is in the series without knowing
// this table exists.
assert.equal(
  corpusMetricName("getRecordsQueryOverheadMs"),
  "getRecordsQueryPagedScanMs",
);
assert.equal(
  corpusMetricName("getRecordsFilterSortGroupByOverheadMs"),
  "getRecordsQueryPagedScanMs",
);

// --- which number ------------------------------------------------------------------

// Not substituted: the case's own primary value, whatever the metrics carry.
assert.equal(
  corpusMetricValue({
    metric: "bulkUpdate5kMs",
    primaryValue: 2028,
    metrics: { getRecordsQueryPagedScanMs: 999 },
  }),
  2028,
);

// Substituted: the component, not the difference.
assert.equal(
  corpusMetricValue({
    metric: "getRecordsQueryOverheadMs",
    primaryValue: 494,
    metrics: { getRecordsQueryPagedScanMs: 2065 },
  }),
  2065,
);

// A reading the clamp floored at zero is usable once the difference is gone.
// `Primary_Metric_Value > 0` drops 971 of the 4860 rows on these twenty cases;
// the component is present and positive on all 4860.
assert.equal(
  corpusMetricValue({
    metric: "getRecordsQueryOverheadMs",
    primaryValue: 0,
    metrics: { getRecordsQueryPagedScanMs: 1904 },
  }),
  1904,
);

// A missing component is `undefined`, so the caller drops the measurement. One
// point of a different quantity in a series is worse than one point fewer.
assert.equal(
  corpusMetricValue({
    metric: "getRecordsQueryOverheadMs",
    primaryValue: 494,
    metrics: {},
  }),
  undefined,
);
assert.equal(
  corpusMetricValue({ metric: "getRecordsQueryOverheadMs", primaryValue: 494 }),
  undefined,
);
assert.equal(corpusMetricValue(), undefined);

// --- the guard of last resort --------------------------------------------------------

// Every substituted metric is refused as a drift, and the substituted name is
// accepted — that pairing is the whole arrangement. A series that still holds a
// difference is one the substitution could not reach.
assert.equal(carriesDrift("getRecordsQueryPagedScanMs"), true);
assert.equal(carriesDrift("duplicateSingleP95Ms"), true);
assert.equal(carriesDrift(undefined), true, "an unknown metric is not refused");
for (const [from, to] of SUBSTITUTED_METRICS) {
  assert.equal(carriesDrift(from), false, `${from} must not carry a drift`);
  assert.equal(carriesDrift(to), true, `${to} must carry one`);
}
assert.deepEqual([...DIFFERENTIAL_METRICS], [...SUBSTITUTED_METRICS.keys()]);

// --- the revision that travels with the seen-set ---------------------------------------

// Stable across calls, and it names both sides of every substitution — so a
// table that starts recording a different component re-seeds too, not only one
// that adds or drops a metric.
{
  const revision = corpusMetricRevision();
  assert.equal(revision, corpusMetricRevision());
  for (const [from, to] of SUBSTITUTED_METRICS) {
    assert.ok(revision.includes(from), `${from} missing from the revision`);
    assert.ok(revision.includes(to), `${to} missing from the revision`);
  }
}

// --- kept in step with the runner ------------------------------------------------------

// `isClampedOverheadMetric` in the TypeScript model decides which cases report
// a difference. This file cannot import it, so the names are compared as text:
// a metric declared there and missing here goes on being read as a duration,
// which is exactly the reading that shipped a wrong card.
{
  const source = readFileSync(
    new URL("../framework/runners/record-read-model.ts", import.meta.url),
    "utf8",
  );
  const body = source.slice(
    source.indexOf("export const isClampedOverheadMetric"),
  );
  // Only the compared literals. The parameter's own type is
  // `RecordReadCaseConfig["threshold"]["metric"]`, whose bracket accesses look
  // like string literals to a looser pattern.
  const declared = [
    ...body.slice(0, body.indexOf(";")).matchAll(/metric === "([A-Za-z]+)"/g),
  ].map((match) => match[1]);
  assert.ok(declared.length > 0, "could not read isClampedOverheadMetric");
  assert.deepEqual(
    [...new Set(declared)].sort(),
    [...DIFFERENTIAL_METRICS].sort(),
    "framework/runners/record-read-model.ts declares a clamped overhead metric this table does not substitute",
  );
}

console.log("corpus metric model checks passed");
