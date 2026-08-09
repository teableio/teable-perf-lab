import assert from "node:assert/strict";
import { analyse, runMeasurements } from "./run-shadow-analysis.mjs";

// A corpus the way `build-perf-corpus.mjs` writes one: one entry per case and
// engine, segments of `[ordinal, value, runs]`.
const seriesOf = (caseId, engine, values, { from = 0 } = {}) => ({
  [`${caseId}::${engine}`]: {
    caseId,
    engine,
    segments: [values.map((value, index) => [from + index, value, 1])],
  },
});

const flat = (n, value) => Array.from({ length: n }, () => value);

// Enough points that the fast layer has the 40 past deviations it needs before
// it will judge anything at all.
const LONG = 60;

// --- reading this run's own measurements ------------------------------------

{
  const measured = runMeasurements([
    {
      payload: {
        caseId: "a",
        engine: "v2",
        result: "pass",
        thresholds: [{ actual: 120 }],
      },
    },
    // The control engine is not what the fast layer judges.
    {
      payload: {
        caseId: "a",
        engine: "v1",
        result: "pass",
        thresholds: [{ actual: 900 }],
      },
    },
    // A failure has a duration, but it is the duration of a failure — and the
    // corpus drops it too, so judging it would compare against a history it
    // will never join.
    {
      payload: {
        caseId: "b",
        engine: "v2",
        result: "fail",
        thresholds: [{ actual: 5000 }],
      },
    },
  ]);
  assert.deepEqual([...measured], [["a", 120]]);
}

// A case measured by two shards collapses to the median, which is what the
// corpus does with rows sharing a commit.
{
  const payloadsOf = (values) =>
    values.map((actual) => ({
      payload: {
        caseId: "a",
        engine: "v2",
        result: "pass",
        thresholds: [{ actual }],
      },
    }));
  assert.equal(runMeasurements(payloadsOf([100, 300, 200])).get("a"), 200);
}

// --- the fast layer judges this run, not the tail of the corpus -------------

// The fault this exists to fix. Two single-case dispatches added two rows each
// and left 282 cases untouched, and both runs flagged the same six cases at
// byte-identical ratios — days-old data re-judged and re-reported as if it were
// new. A case this run did not measure is not judged.
{
  const corpus = {
    series: {
      ...seriesOf("measured", "v2", [...flat(LONG, 100)]),
      // Untouched by this run, and its last corpus point is a spike from
      // whenever it was last measured.
      ...seriesOf("stale", "v2", [...flat(LONG, 100), 400]),
    },
  };

  // Without this run's measurements, the stale spike is reported — the old
  // behaviour, kept for a local analysis that has no run of its own.
  const withoutRun = analyse(corpus);
  assert.deepEqual(
    withoutRun.fast.flagged.map((entry) => entry.key),
    ["stale"],
  );

  // With them, the case this run did not measure is not judged at all, and it
  // is counted rather than quietly dropped.
  const withRun = analyse(corpus, { measured: new Map([["measured", 100]]) });
  assert.deepEqual(withRun.fast.flagged, []);
  assert.equal(withRun.fast.judged, 1);
  assert.equal(withRun.fast.skipped["not-measured-this-run"], 1);
}

// This run's own measurement is what gets judged, even where the corpus has not
// caught up with it.
{
  const corpus = { series: seriesOf("a", "v2", flat(LONG, 100)) };
  const analysis = analyse(corpus, { measured: new Map([["a", 400]]) });
  assert.deepEqual(
    analysis.fast.flagged.map((entry) => entry.key),
    ["a"],
  );
  assert.ok(analysis.fast.flagged[0].ratio > 3.9);
}

// --- keeping this run out of its own history --------------------------------

// The shadow runs after the report has already written this run's rows into
// Performance Track, so the corpus it rebuilds contains the point being judged.
// Calibrating a threshold on a sample containing the observation under test is
// the mistake `checkLatest` is shaped to prevent, and reading the corpus tail
// walks straight back into it: the spike raises its own bar and the case comes
// back clean.
{
  const corpus = { series: seriesOf("a", "v2", [...flat(LONG, 100), 400]) };
  const measured = new Map([["a", 400]]);

  // Ordinal LONG is this run's, so the history stops short of it.
  const trimmed = analyse(corpus, { measured, runOrdinal: LONG });
  assert.deepEqual(
    trimmed.fast.flagged.map((entry) => entry.key),
    ["a"],
  );

  // Left in, the same run reports nothing — the spike is in the distribution
  // its own threshold is read off.
  const contaminated = analyse(corpus, { measured });
  assert.deepEqual(contaminated.fast.flagged, []);
}

// --- what a confirmed change point says -------------------------------------

// A clean step in V2 with a flat control, long enough for the confirmed layer.
{
  const step = [...flat(20, 100), ...flat(20, 300)];
  const commits = new Map(
    Array.from({ length: 41 }, (_, ordinal) => [
      ordinal,
      String(ordinal).padStart(2, "0").repeat(20),
    ]),
  );
  const analysis = analyse(
    {
      series: {
        ...seriesOf("a", "v2", step),
        ...seriesOf("a", "v1", flat(40, 50)),
      },
    },
    { commitAt: (ordinal) => commits.get(ordinal) },
  );

  assert.equal(analysis.confirmed.length, 1);
  const [point] = analysis.confirmed;
  assert.equal(point.afterCommit, commits.get(20));
  // Which engine moved, so nobody has to pull both series by hand.
  assert.equal(point.mover, "v2");
  assert.equal(point.v2Ratio, 3);
  assert.equal(point.v1Ratio, 1);
  // And the commits the ±1 tolerance covers, named rather than left to a reader
  // who knows how the tolerance works.
  assert.deepEqual(point.alsoPossible, [commits.get(19), commits.get(21)]);
  assert.equal(point.unmeasuredBetween, 0);
}

// The control moving reads exactly like a V2 regression until the output says
// otherwise. Same paired shift, opposite meaning.
{
  const analysis = analyse({
    series: {
      ...seriesOf("a", "v2", flat(40, 100)),
      ...seriesOf("a", "v1", [...flat(20, 50), ...flat(20, 150)]),
    },
  });
  assert.equal(analysis.confirmed.length, 1);
  assert.equal(analysis.confirmed[0].mover, "v1");
}

console.log("shadow analysis checks passed");

// --- reading the old gate's verdict -------------------------------------------

// The plumbing failure that cost twenty-three runs. Every state is separated,
// because "the old gate flagged nothing" and "nobody asked the old gate" are
// the same zero, and only one of them is evidence.
{
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readOldGate } = await import("./run-shadow-analysis.mjs");

  const dir = await mkdtemp(join(tmpdir(), "old-gate-"));
  const at = async (name, body) => {
    const path = join(dir, name);
    await writeFile(path, JSON.stringify(body));
    process.env.RELEASE_COMPARISON_PATH = path;
    return readOldGate();
  };

  // Pointed at the baseline file: real file, valid JSON, no verdict in it. This
  // is what shipped, and it answered "no regressions" to a question it was
  // never asked.
  const baseline = await at("release-baseline.json", {
    commit: "abc",
    release: "2519",
    runId: "1",
    values: { "a::v2": { value: 100 } },
  });
  assert.equal(baseline.available, false);
  assert.equal(baseline.reason, "not-a-comparison-file");
  assert.deepEqual(baseline.flagged, []);

  // The real comparison.
  const comparison = await at("release-comparison.json", {
    available: true,
    regressions: [{ caseId: "a" }, { caseId: "b" }],
    counts: { compared: 300, slower: 2 },
  });
  assert.equal(comparison.available, true);
  assert.deepEqual(comparison.flagged, ["a", "b"]);
  assert.equal(comparison.compared, 300);

  // A run with no release baseline. The old gate genuinely said nothing, which
  // still cannot be reconciled against — recorded as its own state rather than
  // as agreement.
  const noBaseline = await at("empty.json", {
    available: false,
    regressions: [],
  });
  assert.equal(noBaseline.available, false);
  assert.equal(noBaseline.reason, "no-release-baseline");

  process.env.RELEASE_COMPARISON_PATH = join(dir, "missing.json");
  const missing = await readOldGate();
  assert.equal(missing.available, false);
  assert.equal(missing.reason, "no-comparison-file");
  delete process.env.RELEASE_COMPARISON_PATH;
}

console.log("shadow analysis old-gate checks passed");
