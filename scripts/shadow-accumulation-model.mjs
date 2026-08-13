// Carrying shadow runs across runs, so G1 and G2 are a computation.
//
// `shadow-comparison-model.mjs` reconciles one run and rolls several into the
// numbers section G is written against. Nothing was carrying the several. Each
// run wrote its own artifact and stopped, so ten runs would have left ten
// artifacts on a 90-day retention and a person with a spreadsheet — and the
// question "are we at run 3 or run 7" would have had no answer inside the
// system that is supposed to be producing evidence.
//
// This is the ledger for that, kept the same way the seen-set is: one file,
// restored by cache prefix at the start of a run, appended to, saved under this
// run's key. Not the incident ledger — that is a different thing, gated on the
// triage number. This one only exists to answer G1 and G2 and can be deleted
// the day the switch is made.
//
// Two things it has to get right, both learned from this project's own
// failures:
//
//   - **Not every run counts.** G1 says ten *full* runs. Ten single-case
//     dispatches would re-report the same handful of cases and mean nothing;
//     that is exactly what runs 31192079501 and 31193504224 did. A run counts
//     only if it measured the whole suite and the same-run layer judged that
//     run's own measurements rather than the tail of the corpus.
//   - **A count is not evidence of what it looks like.** The first successful
//     run reports its whole recent history as new change points, because the
//     seen-set starts empty. Marked, and excluded from anything said about the
//     confirmed layer.

// What the backtest predicted for the same-run layer, in flags per run.
//
// Measured on the real 143,350-row history at the 0.99 operating point and
// signed off in acceptance section A: 3.8 same-run flags per run against a bar
// of 5. G2 compares the shadow-measured rate against this number and accepts a
// factor of two either way.
//
// Pinned here rather than remembered, because G2's whole purpose is to catch a
// backtest that flattered itself, and a criterion whose reference number is
// recalled from a document during the comparison is not that criterion.
export const BACKTEST_NEW_PER_RUN = 3.8;

// Either direction. Above the band, the layer fires more than the history said
// it would and the backtest is wrong about noise. Below it, something is
// suppressing findings — a corpus that came back short, a screen that is
// rejecting more than it should — and reading that as "quieter than promised"
// is how a broken input passes for a clean bill.
export const G2_BAND = 2;

// Section G1, verbatim: at least ten full runs.
export const G1_REQUIRED_RUNS = 10;

/**
 * One ledger record from one run's shadow result.
 *
 * `fullRun` comes from the workflow, which knows whether the dispatch asked for
 * every case; it is not inferred from the count of what was measured. A full
 * run where a shard died measured fewer cases and is still a full run that
 * failed, which is a different thing from a single-case dispatch.
 */
export const runRecord = ({
  result = {},
  runId,
  teableEeRef,
  fullRun,
  at,
}) => ({
  runId: runId ?? result.runId,
  teableEeRef: teableEeRef ?? result.teableEeRef,
  at,
  fullRun: Boolean(fullRun),
  // Which point the same-run layer judged. Only `run` counts toward G1: a
  // reconciliation over the tail of the corpus is a comparison of the old gate
  // against days-old data.
  source: result.fast?.source,
  measured: result.fast?.measured,
  judged: result.fast?.judged ?? 0,
  flagged: result.fast?.flagged?.length ?? 0,
  confirmed: result.confirmed?.length ?? 0,
  // The seen-set was empty, so every change point this run reported is a first
  // sighting only because nothing had been recorded before.
  coldStart: (result.seenBefore ?? 0) === 0,
  // Whether the old gate's verdict was read at all. A run without it produces a
  // reconciliation of zeroes that is indistinguishable from a run where the old
  // gate was quiet, and G1 exists to produce reconciliations.
  //
  // Absent on every result written before the field existed, which is the
  // correct reading for those: the twenty-three runs between 2026-08-08 and
  // 2026-08-09 were pointed at the baseline file and reconciled nothing.
  oldGate: result.oldGate ?? { available: false, reason: "not-recorded" },
  counts: result.reconciliation?.counts,
  oldOnly: result.reconciliation?.oldOnly ?? [],
});

/**
 * Append one record, keeping the ledger bounded and free of duplicates.
 *
 * A re-run of the same GitHub run id replaces the earlier record rather than
 * adding a second: attempt 2 of a run measured the same commit and would
 * otherwise count twice toward the ten.
 */
export const appendRun = (ledger = [], record, { limit = 40 } = {}) => {
  const kept = ledger.filter(
    (entry) => !record?.runId || entry.runId !== record.runId,
  );
  kept.push(record);
  return kept.slice(-limit);
};

// Identity for merging. `runId` when there is one; otherwise the record itself,
// so an unidentifiable record is never collapsed into a different one and never
// duplicated by merging the same file twice.
const ledgerKey = (record) => record?.runId ?? JSON.stringify(record);

/**
 * Union of several ledgers, newest `limit` kept.
 *
 * The cache cannot carry this ledger on its own, and the failure is structural
 * rather than a bug to fix in place. Actions cache entries are immutable and the
 * restore matches `perf-shadow-seen-` by prefix, so two runs whose report jobs
 * overlap both fork from the same snapshot and each saves a lineage that does
 * not contain the other. Whichever the next run happens to restore, the other
 * lineage's records are gone.
 *
 * It does not merely stall the count — it walks it backwards. Measured
 * 2026-08-13: G1 read 30 on the previous night's scheduled run and 25 seven full
 * runs later, via 30 → 29 → 27 → 26 → 25.
 *
 * G1 and G2 both survive that. G1 is met many times over, and G2 is flags
 * divided by runs, so a dropped run removes a term from each and leaves a
 * subsample mean. `oldOnly` does not survive it: that set is the union across
 * recorded runs and it is the whole input to G3, the hand review section G
 * requires before the old comparison can be retired. Silently short, it produces
 * a review that looks complete — this project's recurring failure.
 *
 * Every run uploads its own ledger as an artifact, so a lost lineage is still on
 * disk. Merging recovered copies back in repairs the fork without making the
 * cache load-bearing: the cache stays the fast path, the artifacts are the
 * repair, and a failed recovery leaves the run exactly where it was.
 *
 * Later `at` wins for a given `runId` — attempt 2 supersedes attempt 1, the rule
 * `appendRun` already applies. Records with no `at` sort oldest and fall off
 * `limit` first, an undated record being the one least able to justify its place.
 */
export const mergeLedgers = (ledgers = [], { limit = 40 } = {}) => {
  const byKey = new Map();
  for (const ledger of ledgers) {
    for (const record of ledger ?? []) {
      if (!record) {
        continue;
      }
      const key = ledgerKey(record);
      const existing = byKey.get(key);
      if (!existing || (record.at ?? "") >= (existing.at ?? "")) {
        byKey.set(key, record);
      }
    }
  }
  return [...byKey.values()]
    .sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""))
    .slice(-limit);
};

/**
 * The runs that count toward G1, and why the others do not.
 *
 * Reasons are carried rather than the rejected runs being dropped silently. "We
 * have run six of ten" is a very different sentence from "we have run six of
 * ten, and four dispatches this week did not count", and the second one is the
 * one that tells someone to stop dispatching single cases.
 */
export const qualifyingRuns = (ledger = []) => {
  const qualifying = [];
  const rejected = [];
  for (const run of ledger) {
    if (!run.fullRun) {
      rejected.push({ runId: run.runId, reason: "not-a-full-run" });
    } else if (run.source !== "run") {
      rejected.push({ runId: run.runId, reason: "judged-the-corpus-tail" });
    } else if (!run.oldGate?.available) {
      // G1 is not "ten runs of the new system". It is ten runs *alongside the
      // old report*, and the output that matters is where the two disagree. A
      // run that never read the old gate's verdict produces `old: 0, agreed: 0,
      // oldOnly: 0` — the shape of perfect agreement, from an empty input. It
      // is the one failure this criterion cannot be allowed to absorb.
      rejected.push({
        runId: run.runId,
        reason: `no-old-gate-verdict (${run.oldGate?.reason ?? "unknown"})`,
      });
    } else {
      qualifying.push(run);
    }
  }
  return { qualifying, rejected };
};

/**
 * Where G1 and G2 stand, on the runs recorded so far.
 *
 * G2 is computable without the hand review G3 asks for, but only in one
 * direction, and the result says which. What is measured here is the *flag*
 * rate, and a flag is not known to be a false alarm until someone looks: some
 * of them are real regressions, which is the entire point of the layer. So a
 * rate inside the band bounds the false-alarm rate from above and settles G2; a
 * rate above the band does not by itself fail it, because the excess may be
 * genuine findings — that case needs the triage, and says so instead of
 * returning a verdict it cannot support.
 */
export const assessShadow = (
  ledger = [],
  {
    predicted = BACKTEST_NEW_PER_RUN,
    band = G2_BAND,
    required = G1_REQUIRED_RUNS,
  } = {},
) => {
  const { qualifying, rejected } = qualifyingRuns(ledger);
  const runs = qualifying.length;
  const flags = qualifying.reduce((total, run) => total + run.flagged, 0);
  const perRun = runs > 0 ? flags / runs : undefined;
  const ratio = perRun === undefined ? undefined : perRun / predicted;

  const g1 = { met: runs >= required, runs, required, rejected };

  let g2;
  if (runs < required) {
    g2 = {
      met: false,
      verdict: "not-enough-runs",
      perRun,
      predicted,
      ratio,
    };
  } else if (ratio <= band && ratio >= 1 / band) {
    g2 = { met: true, verdict: "within-band", perRun, predicted, ratio };
  } else if (ratio > band) {
    // More flags than the history predicted. Either the backtest understated
    // the noise or the shadow period genuinely had more going wrong in it, and
    // counting cannot tell those apart.
    g2 = {
      met: false,
      verdict: "above-band-needs-triage",
      perRun,
      predicted,
      ratio,
    };
  } else {
    // Fewer flags than predicted, which is not the good news it reads as. The
    // same shape — a well-formed artifact reporting almost nothing — is what a
    // shallow clone produced, twice.
    g2 = {
      met: false,
      verdict: "below-band-check-inputs",
      perRun,
      predicted,
      ratio,
    };
  }

  return {
    g1,
    g2,
    // Only runs after the first tell you anything about the confirmed layer's
    // rate, because the first reports its whole recent history.
    confirmedRuns: qualifying.filter((run) => !run.coldStart).length,
    confirmedTotal: qualifying
      .filter((run) => !run.coldStart)
      .reduce((total, run) => total + run.confirmed, 0),
  };
};

/**
 * One line per run and a verdict, for the job summary.
 *
 * Written for someone who is watching this accumulate over a week and wants to
 * know, in one glance, whether the run that just finished counted.
 */
export const renderShadowProgress = (ledger = [], options = {}) => {
  const assessment = assessShadow(ledger, options);
  const { g1, g2 } = assessment;

  const lines = [
    `- G1: ${g1.runs} of ${g1.required} qualifying full runs${g1.met ? " — met" : ""}`,
  ];
  if (g1.rejected.length > 0) {
    const reasons = g1.rejected.reduce((tally, entry) => {
      tally[entry.reason] = (tally[entry.reason] ?? 0) + 1;
      return tally;
    }, {});
    lines.push(
      `- not counted: ${Object.entries(reasons)
        .map(([reason, count]) => `${count} ${reason}`)
        .join(", ")}`,
    );
  }
  const band = options.band ?? G2_BAND;
  if (g2.perRun === undefined) {
    lines.push(
      `- G2: no qualifying runs yet (backtest predicted ${g2.predicted}/run)`,
    );
  } else {
    lines.push(
      `- G2: ${g2.perRun.toFixed(1)} same-run flags per run against a predicted ${g2.predicted}` +
        ` (${g2.ratio.toFixed(2)}x, band ${(1 / band).toFixed(2)}–${band}x) — ${g2.verdict}`,
    );
  }
  lines.push(
    `- confirmed layer: ${assessment.confirmedTotal} change points over ${assessment.confirmedRuns} runs` +
      ` (the cold-start run is excluded; it reports its whole recent history)`,
  );
  return lines.join("\n");
};
