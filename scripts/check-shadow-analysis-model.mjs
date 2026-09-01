import assert from "node:assert/strict";
import {
  analyse,
  comparableSegment,
  CONFIRMED_DETECTOR_REVISION,
  DEFAULT_ANALYSIS_WINDOW,
  reseedDecision,
  runMeasurements,
  seenDetectorOf,
  seenMetricsOf,
  seenWindowOf,
} from "./run-shadow-analysis.mjs";
import { corpusMetricRevision } from "./corpus-metric-model.mjs";

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

assert.deepEqual(
  comparableSegment({
    segments: [
      [[0, 100]],
      [
        [1, 200],
        [2, 200],
      ],
    ],
    preferredSegmentIndex: 0,
  }),
  [[0, 100]],
);

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
  assert.equal(point.evidenceLevel, "confirmed_shift");
  assert.equal(point.historyCompatibility, "legacy");
  assert.equal(point.afterCommit, commits.get(20));
  // Which engine moved, so nobody has to pull both series by hand.
  assert.equal(point.mover, "v2");
  assert.equal(point.v2Ratio, 3);
  assert.equal(point.v1Ratio, 1);
  assert.equal(point.controlMode, "global-run-effect");
  assert.equal(point.v1Comparison, "separate-runner-cohort");
  // And the commits the ±1 tolerance covers, named rather than left to a reader
  // who knows how the tolerance works.
  assert.deepEqual(point.alsoPossible, [commits.get(19), commits.get(21)]);
  assert.equal(point.unmeasuredBetween, 0);
}

// V1 runs on another matrix VM. A V1-only movement is corroborating cohort
// evidence and must not create a V2 change point.
{
  const analysis = analyse({
    series: {
      ...seriesOf("a", "v2", flat(40, 100)),
      ...seriesOf("a", "v1", [...flat(20, 50), ...flat(20, 150)]),
    },
  });
  assert.equal(analysis.confirmed.length, 0);
}

// One noisy runner wave across a broad cohort is removed from V2 history. A
// single case regression at the same commit survives the median run effect.
{
  const all = {};
  for (let index = 0; index < 20; index += 1) {
    const values = flat(40, 100);
    values[20] = index === 0 ? 450 : 150;
    if (index === 0) {
      values.fill(300, 21);
    }
    Object.assign(all, seriesOf(`case-${index}`, "v2", values));
  }
  const analysis = analyse({ series: all });
  assert.deepEqual(
    analysis.confirmed.map((point) => point.caseId),
    ["case-0"],
  );
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

// --- recovering a seen-set the cache forked or lost --------------------------

{
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { readRecoveredSeen } = await import("./run-shadow-analysis.mjs");

  const dir = await mkdtemp(join(tmpdir(), "shadow-recovery-"));
  const copy = async (runId, known) => {
    await mkdir(join(dir, runId), { recursive: true });
    await writeFile(
      join(dir, runId, "shadow-seen.json"),
      JSON.stringify({ known }),
    );
  };

  // Two runs that overlapped: each saved a lineage the other does not contain.
  // The union is what neither of them has on its own.
  await copy("1001", ["case-a@x..y", "case-b@x..y"]);
  await copy("1002", ["case-a@x..y", "case-c@x..y"]);
  assert.deepEqual((await readRecoveredSeen(dir)).sort(), [
    "case-a@x..y",
    "case-b@x..y",
    "case-c@x..y",
  ]);

  // A set that only grows needs no merge rule beyond taking everything, so
  // reading the same copies twice cannot change the answer.
  assert.equal((await readRecoveredSeen(dir)).length, 3);

  // One unreadable copy is one copy, not the run. The 2026-08-09 wipe is the
  // case this exists for, and it must not be turned into a second failure.
  await mkdir(join(dir, "1003"), { recursive: true });
  await writeFile(join(dir, "1003", "shadow-seen.json"), "{ not json");
  assert.equal((await readRecoveredSeen(dir)).length, 3);

  // No directory, or none configured, leaves the run where it was before any of
  // this existed: on the cache alone.
  assert.deepEqual(await readRecoveredSeen(join(dir, "absent")), []);
  assert.deepEqual(await readRecoveredSeen(undefined), []);
  assert.deepEqual(await readRecoveredSeen(""), []);
}

// --- the four states the seen-set can arrive in ------------------------------
//
// The whole point of the recovery is that a silent failure became loud, so the
// branch that decides whether to shout is worth a test of its own. A reporter
// that picks the wrong branch is the same defect again, one level up.

{
  const { reportSeenSources } = await import("./run-shadow-analysis.mjs");
  const said = () => {
    const lines = { warn: [], log: [] };
    return {
      lines,
      log: {
        warn: (m) => lines.warn.push(m),
        log: (m) => lines.log.push(m),
      },
    };
  };

  // The 2026-08-09 wipe, with the repair in place. Must warn: the cache lost a
  // history that demonstrably existed, and the miss wants investigating even
  // though this run is now fine.
  {
    const t = said();
    reportSeenSources(
      { cached: undefined, recovered: ["a", "b"], seen: ["a", "b"] },
      t.log,
    );
    assert.equal(t.lines.warn.length, 1);
    assert.match(t.lines.warn[0], /cache missed and 2 keys were recovered/);
  }

  // A genuine cold start. Identical input shape to the wipe apart from there
  // being nothing to recover, and it must not warn — the two reading the same
  // is how the wipe went unnoticed for four days, in the other direction.
  {
    const t = said();
    reportSeenSources({ cached: undefined, recovered: [], seen: [] }, t.log);
    assert.equal(t.lines.warn.length, 0);
    assert.match(t.lines.log[0], /cold start/);
  }

  // A fork: the cache came back, short. Warns with the count it put back.
  {
    const t = said();
    reportSeenSources(
      { cached: ["a"], recovered: ["a", "b"], seen: ["a", "b"] },
      t.log,
    );
    assert.equal(t.lines.warn.length, 1);
    assert.match(
      t.lines.warn[0],
      /returned 1 keys and recent run artifacts held 1 more/,
    );
  }

  // The ordinary run. The cache had everything; recovery confirmed it and there
  // is nothing to say beyond the count.
  {
    const t = said();
    reportSeenSources(
      { cached: ["a", "b"], recovered: ["a"], seen: ["a", "b"] },
      t.log,
    );
    assert.equal(t.lines.warn.length, 0);
    assert.match(t.lines.log[0], /2 keys, cache complete/);
  }

  // Recovery unavailable and the cache intact — also ordinary, and silent.
  {
    const t = said();
    reportSeenSources({ cached: ["a"], recovered: [], seen: ["a"] }, t.log);
    assert.equal(t.lines.warn.length, 0);
  }
}

// --- the analysis window, and the re-seed that a change to it forces ----------

// Whole series, since 2026-08-13. Widening it recovers 5 of the 11 cases that
// drifted 1.3x or more across their history and had never been reported: the
// detector found them, the 80-point window did not reach back far enough.
assert.equal(DEFAULT_ANALYSIS_WINDOW, Infinity);

// A seen-set written before the window was recorded was built under 80.
assert.equal(seenWindowOf({ known: [] }), 80);
assert.equal(seenWindowOf(undefined), 80);
assert.equal(seenWindowOf({ known: [], window: 80 }), 80);

// The round trip that matters. `Infinity` does not survive JSON — it comes back
// as `null` — so reading `null` as anything but `Infinity` makes every
// full-scan run differ from the one before it. That re-seeds nightly, and a
// re-seed announces nothing, which silences the card permanently while every
// step stays green.
{
  const written = JSON.parse(
    JSON.stringify({
      known: ["a"],
      window: Number.isFinite(DEFAULT_ANALYSIS_WINDOW)
        ? DEFAULT_ANALYSIS_WINDOW
        : null,
    }),
  );
  assert.equal(written.window, null);
  assert.equal(seenWindowOf(written), DEFAULT_ANALYSIS_WINDOW);
  assert.equal(
    seenWindowOf(written) !== DEFAULT_ANALYSIS_WINDOW,
    false,
    "a full-scan seen-set must not read as a window change on the next run",
  );
}

// Changing it in either direction is a change: boundaries move both ways, and
// on `record-read/10k-50fields-filter-sort-formula-selective` the 80-point
// window reports a boundary at position 190 that a full scan does not report
// at all.
assert.notEqual(
  seenWindowOf({ known: [], window: 80 }),
  DEFAULT_ANALYSIS_WINDOW,
);

// --- the re-seed decision -----------------------------------------------------

// Exported and checked because `main` is only ever run as a script: nothing in
// this suite executes a line of it. The first version of this logic lived
// inline in `main` and referenced `analysisWindow`, which is a parameter of
// `analyse` and not a binding `main` has. Everything passed. CI found it
// fourteen minutes into a run, after the corpus had been rebuilt from 180,907
// rows, and the three steps after it — the ledger, the card and the cache save
// — were skipped.

// No stored window: a seen-set from before the field existed, handled by
// `seenWindowOf` rather than here.
assert.equal(reseedDecision({ cachedWindow: undefined }).reseeding, false);

// Steady state. This is the one that has to hold every night, and the one the
// `Infinity`/`null` round trip would have broken.
assert.equal(
  reseedDecision({ cachedWindow: DEFAULT_ANALYSIS_WINDOW }).reseeding,
  false,
);

// Widened. Announce nothing, and say why in both the log and an annotation.
{
  const decision = reseedDecision({
    cachedWindow: 80,
    freshCount: 117,
    knownCount: 300,
  });
  assert.equal(decision.reseeding, true);
  assert.match(decision.reason, /window changed from 80 to full-history/);
  assert.match(decision.reason, /117 change points/);
  assert.match(decision.reason, /300 keys/);
  assert.match(decision.warning, /^::warning title=/);
}

// Narrowed, which is the same problem in the other direction.
assert.equal(
  reseedDecision({ cachedWindow: DEFAULT_ANALYSIS_WINDOW, analysisWindow: 80 })
    .reseeding,
  true,
);

// --- and the other thing that moves every boundary ------------------------------

// A seen-set written before the corpus substituted anything records no metric
// revision. Read as the pre-substitution state, so the first run after the swap
// re-seeds once rather than announcing twenty cases' histories.
assert.equal(seenMetricsOf({}), "primary-metric");
assert.equal(seenMetricsOf(undefined), "primary-metric");
assert.equal(seenMetricsOf({ metrics: "x>y" }), "x>y");
assert.equal(seenDetectorOf({}), "v1-v2-separate-runner-difference");
assert.equal(seenDetectorOf(undefined), "v1-v2-separate-runner-difference");
assert.equal(seenDetectorOf({ detector: "x" }), "x");

// Round-tripped through JSON, because that is how it travels and how the window
// field broke: `window: null` read back as `null` rather than `Infinity` and
// would have re-seeded nightly, silencing the card for good.
{
  const written = JSON.parse(
    JSON.stringify({
      known: [],
      window: null,
      metrics: corpusMetricRevision(),
      detector: CONFIRMED_DETECTOR_REVISION,
    }),
  );
  assert.equal(
    reseedDecision({
      cachedWindow: seenWindowOf(written),
      cachedMetrics: seenMetricsOf(written),
      cachedDetector: seenDetectorOf(written),
    }).reseeding,
    false,
    "a seen-set this run wrote must not re-seed the next one",
  );
}

// The detector's statistical meaning changed. Re-seed exactly once instead of
// announcing shifted historical boundaries as new regressions.
{
  const decision = reseedDecision({
    cachedWindow: DEFAULT_ANALYSIS_WINDOW,
    cachedMetrics: corpusMetricRevision(),
    cachedDetector: "v1-v2-separate-runner-difference",
  });
  assert.equal(decision.reseeding, true);
  assert.match(decision.reason, /confirmed detector changed/);
}

// The substitution landing for the first time.
{
  const decision = reseedDecision({
    cachedWindow: DEFAULT_ANALYSIS_WINDOW,
    cachedMetrics: "primary-metric",
    freshCount: 240,
    knownCount: 577,
  });
  assert.equal(decision.reseeding, true);
  assert.match(decision.reason, /changed which metric it records/);
  assert.match(decision.reason, /primary-metric →/);
  assert.match(decision.reason, /240 change points/);
  assert.doesNotMatch(decision.reason, /window changed/);
}

// Both at once reads as both, rather than whichever is checked first.
{
  const decision = reseedDecision({
    cachedWindow: 80,
    cachedMetrics: "primary-metric",
  });
  assert.match(decision.reason, /window changed from 80 to full-history/);
  assert.match(decision.reason, /changed which metric it records/);
}

// Nothing cached is the cold start, which has its own handling, and must not be
// turned into a re-seed by the metric field being absent too.
assert.equal(
  reseedDecision({ cachedWindow: undefined, cachedMetrics: undefined })
    .reseeding,
  false,
);

console.log("shadow analysis old-gate and seen-set recovery checks passed");
