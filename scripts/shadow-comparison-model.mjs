// Reconciling the old gate against the new system, run by run.
//
// Shadow mode exists to produce one thing: a per-case account of where the two
// disagree, accumulated over at least ten full runs, so the decision to switch
// rests on observation rather than on the backtest that argued for it. Section
// G of the acceptance criteria will not accept a switch until the measured
// false-alarm rate lands within 2x of what the backtest predicted, and this is
// what measures it.
//
// Four buckets, and the two that matter are the disagreements:
//
//   - `agreed` — both flagged it. No information; the case would have been
//     looked at either way.
//   - `oldOnly` — the 20% gate fired and the new system did not. Each of these
//     is a claim that the old alarm was noise. Measurement says most will be:
//     the gate fires on 29.9% of cases from identical code. But "most" is not
//     "all", and every one of these has to be reviewed by hand, because this is
//     the bucket where the new system loses something real.
//   - `newOnly` — the new system flagged a case the gate missed. The gate is
//     blind to a regression smaller than 20% on a quiet case, which is most of
//     what a per-case threshold is for.
//   - `confirmed` — a change point the new system confirmed. The old gate has
//     no equivalent output at all, so these are listed rather than compared.
//
// The asymmetry is deliberate. `oldOnly` is the risk of switching and gets the
// scrutiny; `newOnly` is the benefit and only needs counting.
//
// Nothing here decides whether to switch. It produces the evidence and the
// counts; the criteria in the acceptance document decide, and a human applies
// them.

/**
 * Reconcile one run.
 *
 * `oldFlagged` and `newFlagged` are case ids. `confirmed` are the change points
 * the confirmed layer reported this run, which have no counterpart on the old
 * side.
 *
 * `unjudged` are cases the new system declined to judge — too little history,
 * too noisy to be measurable, no usable value. They are carried separately and
 * never folded into "the new system said nothing", because a case nobody could
 * judge is not a case that looked fine. Where the old gate flagged one of them,
 * that is a coverage gap rather than a disagreement, and it is reported as its
 * own bucket.
 */
export const reconcileRun = ({
  oldFlagged = [],
  newFlagged = [],
  confirmed = [],
  unjudged = [],
} = {}) => {
  const oldSet = new Set(oldFlagged);
  const newSet = new Set(newFlagged);
  const unjudgedSet = new Set(unjudged);

  const agreed = [];
  const oldOnly = [];
  const newOnly = [];
  const oldOnlyUnjudged = [];

  for (const caseId of oldSet) {
    if (newSet.has(caseId)) {
      agreed.push(caseId);
    } else if (unjudgedSet.has(caseId)) {
      // The new system did not disagree here — it abstained. Counting this as
      // "the new system says it is fine" would credit it for a judgement it
      // never made.
      oldOnlyUnjudged.push(caseId);
    } else {
      oldOnly.push(caseId);
    }
  }
  for (const caseId of newSet) {
    if (!oldSet.has(caseId)) {
      newOnly.push(caseId);
    }
  }

  const sorted = (list) => [...list].sort();
  return {
    agreed: sorted(agreed),
    oldOnly: sorted(oldOnly),
    oldOnlyUnjudged: sorted(oldOnlyUnjudged),
    newOnly: sorted(newOnly),
    confirmed: [...confirmed],
    counts: {
      old: oldSet.size,
      new: newSet.size,
      agreed: agreed.length,
      oldOnly: oldOnly.length,
      oldOnlyUnjudged: oldOnlyUnjudged.length,
      newOnly: newOnly.length,
      confirmed: confirmed.length,
      unjudged: unjudgedSet.size,
    },
  };
};

/**
 * Roll several runs into the numbers section G is written against.
 *
 * `newPerRun` is the figure the backtest predicted, and the one section G
 * compares against a 2x band. It counts the same-run layer only: the confirmed
 * layer fires on incidents rather than on runs, so averaging it per run would
 * describe nothing.
 *
 * `reviewed` carries the hand-review verdicts on `oldOnly` cases, since those
 * cannot be settled by counting. Until every one is reviewed the accumulated
 * result is incomplete, and `complete` says so rather than letting a partial
 * review read as a clean bill.
 */
export const accumulate = (runs = [], { reviewed = {} } = {}) => {
  const totals = {
    runs: runs.length,
    old: 0,
    new: 0,
    agreed: 0,
    oldOnly: 0,
    oldOnlyUnjudged: 0,
    newOnly: 0,
    confirmed: 0,
  };
  const oldOnlyCases = new Set();

  for (const run of runs) {
    for (const key of Object.keys(totals)) {
      if (key !== "runs") {
        totals[key] += run.counts?.[key] ?? 0;
      }
    }
    for (const caseId of run.oldOnly ?? []) {
      oldOnlyCases.add(caseId);
    }
  }

  const verdicts = { noise: 0, real: 0, unreviewed: 0 };
  for (const caseId of oldOnlyCases) {
    const verdict = reviewed[caseId];
    if (verdict === "noise" || verdict === "real") {
      verdicts[verdict] += 1;
    } else {
      verdicts.unreviewed += 1;
    }
  }

  return {
    ...totals,
    newPerRun: runs.length > 0 ? totals.new / runs.length : 0,
    oldPerRun: runs.length > 0 ? totals.old / runs.length : 0,
    oldOnlyCases: [...oldOnlyCases].sort(),
    review: verdicts,
    // Section G needs ten runs and a finished review of everything the new
    // system dropped. Either one missing means the comparison is not yet
    // evidence, and saying so here keeps a partial result from being quoted as
    // a conclusion.
    complete: runs.length >= 10 && verdicts.unreviewed === 0,
  };
};
