// Shadow-mode analysis: run the new detection alongside the existing report
// without touching it.
//
// This is the entry point CI calls after a full run. It refreshes the corpus,
// runs both detection layers over it, reconciles the result against what the
// existing 20% gate flagged, and writes one artifact. Nothing here sends a
// message or changes the Feishu card — section G of the acceptance criteria
// will not accept a switch until ten runs of this have been compared by hand.
//
// Two constraints from the repository being public while teable-ee is not:
//
//   - Commit ordering resolves at runtime into the run's workspace and is never
//     written back into the repo. The ordering artifact is a list of every
//     teable-ee mainline commit in order, which describes that repository's
//     size and cadence; a bare SHA is already carried here, a full history is
//     a different thing.
//   - The output names commits by SHA and stops there. What a commit changed
//     goes in the internal issue tracker.
//
// Failure here must never fail the run. The existing report is what the team
// depends on today, and a shadow that cannot compute is a shadow that reports
// nothing — not a reason to lose a run's results. That is arranged in the
// workflow, not by hiding errors here: the step carries `continue-on-error` and
// runs after every step the run depends on, which leaves this free to exit
// non-zero and be seen doing it.

import { spawn } from "node:child_process";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import {
  access,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "./env.mjs";
import {
  benjaminiHochberg,
  detectChangePointsWindowed,
} from "./change-point-model.mjs";
import { pairedSeries } from "./control-channel-model.mjs";
import { measurabilityOf } from "./measurability-model.mjs";
import { checkRun } from "./fast-check-model.mjs";
import { reconcileRun } from "./shadow-comparison-model.mjs";
import { separateFresh } from "./change-point-identity-model.mjs";
import {
  attributeMovement,
  attributionCandidates,
} from "./change-point-attribution-model.mjs";
import {
  primaryMetricValue,
  readArtifactPayloads,
} from "./perf-artifact-read-model.mjs";

export const SHADOW_RESULT_FILE_NAME = "shadow-analysis.json";

// Change point keys already reported, carried between runs.
//
// Without it every run re-announces every change point in recent history — 101
// of them, almost all seen before. The file is the difference between an alert
// and a standing inventory.
export const SHADOW_SEEN_FILE_NAME = "shadow-seen.json";

const median = (values) => {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = sorted.length >> 1;
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

// The case's own noise scale, used as the effect-size gate. The median of
// adjacent differences is blind to a level shift — that contributes one large
// difference among many small ones — so a regressed case is not mistaken for a
// noisy one and gated out.
const noiseOf = (values) => {
  const steps = [];
  for (let index = 1; index < values.length; index += 1) {
    steps.push(values[index] - values[index - 1]);
  }
  const centre = median(steps);
  return (
    median(steps.map((step) => Math.abs(step - centre))) / 0.6745 / Math.SQRT2
  );
};

const longestSegment = (entry) =>
  entry.segments.reduce(
    (longest, segment) => (segment.length > longest.length ? segment : longest),
    [],
  );

/**
 * Spawn a child, hand it `input` on stdin, and give back its stdout.
 *
 * stdin is closed every time, with or without input to send. Asynchronous
 * `execFile` has no `input` option — that belongs to `execFileSync` — and
 * silently ignores it, so the child is left holding a pipe that never reaches
 * end-of-input. Both ordering resolvers read stdin to EOF before they do
 * anything, and waited for a close that was never coming: 34 minutes of no
 * output in CI, killed by SIGTERM when the report job hit its own 30-minute
 * limit, taking that job's remaining steps down with it.
 *
 * stderr is inherited rather than collected. A child that is retrying a page or
 * about to fail should say so while it is happening; collecting it means the
 * log stays empty until the process ends, which is exactly the case where
 * nobody can see what is wrong.
 */
const run = (command, args, { input = "", capture = true, ...options } = {}) =>
  new Promise((settle, fail) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["pipe", capture ? "pipe" : "inherit", "inherit"],
    });

    let stdout = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });

    child.once("error", fail);
    child.once("close", (code) => {
      if (code === 0) {
        settle(stdout);
        return;
      }
      fail(new Error(`${command} ${args.join(" ")} exited with code ${code}`));
    });

    // Three of the five stages never read stdin and can exit before the close
    // lands, which arrives as EPIPE on a stream with no listener — an unhandled
    // error event, which is fatal. The child's own exit code is the answer that
    // matters here, so this one is discarded rather than reported.
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });

const countLines = (text) => text.split("\n").filter(Boolean).length;

/**
 * Rebuild the ordering and digest inputs, then the corpus, into the workspace.
 *
 * Every path is under `workDir`, which CI discards when the run ends. Nothing
 * is written into the repository.
 *
 * Each stage announces itself first. The stages are minutes long and three of
 * them talk to the network, so a log that only prints on success cannot tell a
 * slow stage from a stuck one — which is how the stdin hang above went 34
 * minutes without anyone being able to say where it was.
 */
export const refreshCorpus = async ({ workDir, teableEeRepo }) => {
  const orderPath = resolve(workDir, "commit-order.json");
  const digestPath = resolve(workDir, "case-digests.json");
  const corpusPath = resolve(workDir, "perf-corpus.json");

  // Checked before the refs query rather than after, so that a missing clone
  // reads as a missing clone. Left to git it arrives as `cannot change to
  // 'teable-ee-revision'` from a step that already ran two minutes of network
  // work for nothing.
  try {
    await access(resolve(teableEeRepo, ".git"));
  } catch {
    throw new Error(
      `No teable-ee clone at ${teableEeRepo}. Commit ordering needs the mainline first-parent chain; check out teableio/teable-ee to that path before this runs.`,
    );
  }

  console.log("Shadow: listing teable-ee refs…");
  const refs = await run("node", [
    resolve("scripts/list-corpus-refs.mjs"),
    "--teable-ee",
  ]);

  console.log(`Shadow: positioning ${countLines(refs)} teable-ee refs…`);
  await run("node", [resolve("scripts/resolve-commit-order.mjs")], {
    input: refs,
    capture: false,
    env: {
      ...process.env,
      TEABLE_EE_REPO: teableEeRepo,
      COMMIT_ORDER_PATH: orderPath,
    },
  });

  console.log("Shadow: listing perf-lab refs…");
  const perfRefs = await run("node", [
    resolve("scripts/list-corpus-refs.mjs"),
    "--perf-lab",
  ]);

  console.log(`Shadow: digesting ${countLines(perfRefs)} perf-lab commits…`);
  await run("node", [resolve("scripts/resolve-case-digests.mjs")], {
    input: perfRefs,
    capture: false,
    env: { ...process.env, CASE_DIGESTS_PATH: digestPath },
  });

  console.log("Shadow: building corpus…");
  await run("node", [resolve("scripts/build-perf-corpus.mjs")], {
    capture: false,
    env: {
      ...process.env,
      COMMIT_ORDER_PATH: orderPath,
      CASE_DIGESTS_PATH: digestPath,
      PERF_CORPUS_PATH: corpusPath,
    },
  });

  return JSON.parse(await readFile(corpusPath, "utf8"));
};

// How much recent history the per-run confirmed pass looks at.
//
// Not the whole series. A change point from three months ago was reported three
// months ago, and re-deriving it every run costs the windowed pass fourteen
// times the work of the plain one — measured, a full-history windowed scan runs
// past ten minutes, against a budget of thirty seconds a run.
//
// Long enough to contain what the detector can act on: the confirmed layer
// needs about twenty runs behind a regression to reach its stated recall, and
// this holds four times that. Anything older is the offline periodic scan's
// job, not this one's.
export const DEFAULT_ANALYSIS_WINDOW = 80;

/**
 * Both layers over the corpus.
 *
 * The fast layer judges this run's own measurement of each case against that
 * case's history. The confirmed layer looks at the whole series, on the
 * V1-paired values where a control exists, and applies one FDR correction
 * across every hypothesis tested.
 *
 * `measured` is what this run actually measured, as `caseId -> value`. Without
 * it the fast layer falls back to the last point in the corpus, which is only
 * this run's measurement for the cases this run measured — on a partial
 * dispatch every other case gets judged on whenever it was last measured, and
 * re-flagged as if it were new. That is exactly what runs 31192079501 and
 * 31193504224 did: both single-case dispatches of `smoke/auth-user`, both
 * reporting the same six flags at byte-identical ratios, which reads as
 * stability and is the same days-old data twice. A case this run did not
 * measure is not judged at all; it is counted under `not-measured-this-run`,
 * because a case nobody looked at is not a case that looked fine.
 *
 * `runOrdinal` is the mainline position of the commit under test, used to keep
 * this run's own rows out of the history it is judged against. Calibrating a
 * threshold on a sample containing the observation being tested is the one
 * mistake `checkLatest` is written to make impossible, and reading the corpus
 * after this run has already reported into it puts it right back.
 */
export const analyse = (
  corpus,
  {
    analysisWindow = DEFAULT_ANALYSIS_WINDOW,
    // Mainline ordinal to commit SHA. The corpus stores ordinals to keep the
    // artifact small, but a change point's identity has to be the commit — an
    // ordinal indexes a corpus that grows and gets re-segmented, and an
    // identity that shifts underneath the ledger cannot accumulate. Without
    // this map the key falls back to the ordinal and says so with a `#`.
    commitAt = () => undefined,
    measured,
    runOrdinal,
  } = {},
) => {
  const series = corpus.series ?? {};
  const fastCases = {};
  const unjudged = [];
  const points = [];
  let notMeasured = 0;
  let tested = 0;

  for (const [key, entry] of Object.entries(series)) {
    if (entry.engine !== "v2") continue;
    const segment = longestSegment(entry);
    const values = segment.map(([, value]) => value);

    const measurable = measurabilityOf(values);
    if (!measurable.measurable) {
      unjudged.push(entry.caseId);
      continue;
    }

    if (!measured) {
      fastCases[entry.caseId] = {
        history: values.slice(0, -1),
        latest: values[values.length - 1],
      };
    } else if (measured.has(entry.caseId)) {
      // Everything the corpus holds from before this run. Where the commit
      // under test is positioned, that is every point at a lower ordinal —
      // which also drops the point this run just contributed, and any earlier
      // run of the same commit that it was merged with. Where it is not
      // positioned, this run put nothing in the corpus and the whole series is
      // history.
      const history = Number.isInteger(runOrdinal)
        ? segment
            .filter(([ordinal]) => ordinal < runOrdinal)
            .map(([, value]) => value)
        : values;
      fastCases[entry.caseId] = {
        history,
        latest: measured.get(entry.caseId),
      };
    } else {
      notMeasured += 1;
    }

    const control = series[`${entry.caseId}::v1`];
    const analysed = control
      ? pairedSeries({
          v2: segment.map(([ordinal, value]) => [ordinal, value]),
          v1: longestSegment(control).map(([ordinal, value]) => [
            ordinal,
            value,
          ]),
        }).points
      : segment.map(([ordinal, value]) => [ordinal, Math.log(value)]);

    if (analysed.length < 30) continue;
    const recent = analysed.slice(-analysisWindow);
    const logs = recent.map(([, value]) => value);
    const found = detectChangePointsWindowed(logs, {
      minSegment: 4,
      minShift: noiseOf(logs),
      seed: 7,
    });
    tested += found.tested;
    const controlSegment = control
      ? longestSegment(control).map(([ordinal, value]) => [ordinal, value])
      : [];

    for (const point of found.points) {
      const beforeOrdinal = recent[point.index - 1]?.[0];
      const afterOrdinal = recent[point.index]?.[0];

      // Which engine actually moved, on the raw values rather than the paired
      // ones. The reported ratio is the ratio of `v2/v1`, so a control that
      // moved reads identically to a V2 regression until someone pulls both
      // series by hand — which is four wasted triages per seventy-five change
      // points, measured.
      const movement = attributeMovement({
        v2: segment.map(([ordinal, value]) => [ordinal, value]),
        v1: controlSegment,
        boundaryOrdinal: afterOrdinal,
      });

      // The named commit, plus the ones the ±1 tolerance covers. A SHA in an
      // alert reads as an answer, and whoever triages opens exactly the commit
      // named — so its neighbours are named too, rather than left to a reader
      // who knows how the tolerance works.
      const candidates = attributionCandidates({
        afterOrdinal,
        beforeOrdinal,
        previous: [afterOrdinal - 1, commitAt(afterOrdinal - 1)],
        next: [afterOrdinal + 1, commitAt(afterOrdinal + 1)],
      });

      points.push({
        caseId: entry.caseId,
        beforeCommit: commitAt(beforeOrdinal) ?? `#${beforeOrdinal}`,
        afterCommit: commitAt(afterOrdinal) ?? `#${afterOrdinal}`,
        beforeOrdinal,
        afterOrdinal,
        ratio: Math.exp(point.shift),
        pValue: point.pValue,
        paired: Boolean(control),
        mover: movement.mover,
        v2Ratio: movement.v2 ? Number(movement.v2.ratio.toFixed(3)) : undefined,
        v1Ratio: movement.v1 ? Number(movement.v1.ratio.toFixed(3)) : undefined,
        v2Level: movement.v2
          ? { before: movement.v2.before, after: movement.v2.after }
          : undefined,
        v1Level: movement.v1
          ? { before: movement.v1.before, after: movement.v1.after }
          : undefined,
        alsoPossible: candidates.alsoPossible,
        unmeasuredBetween: candidates.unmeasuredBetween,
      });
    }
  }

  const correction = benjaminiHochberg(
    points.map((point) => point.pValue),
    0.05,
    tested,
  );
  const confirmed = points.filter((_, index) => correction.significant[index]);

  const fast = checkRun(fastCases);
  if (notMeasured > 0) {
    fast.skipped = { ...fast.skipped, "not-measured-this-run": notMeasured };
  }
  return {
    fast,
    confirmed,
    unjudged,
    tested,
    candidates: points.length,
  };
};

// Half the refs the history measured should sit on the mainline. Measured on a
// good clone it is 86% (494 of 571); the rest are force-pushed or off-mainline
// branches and always will be.
const MIN_POSITIONED_FRACTION = 0.5;

// The confirmed layer skips any series with fewer than 30 points, so a corpus
// whose typical series is shorter than that cannot answer the question no
// matter what the detector does.
const MIN_MEDIAN_SEGMENT = 30;

/**
 * Refuse to analyse inputs that cannot carry an answer.
 *
 * A zero is a claim. "No regressions this run" and "no history to look at" come
 * out of the detector as the same number, and only one of them is worth
 * reporting — so the difference has to be established here, before the result
 * is written, rather than left for a reader to notice.
 *
 * It went wrong exactly this way in CI: `actions/checkout` clones shallow, and
 * `git fetch --filter=tree:0` does not undo that, so the mainline was one commit
 * long. 572 of 573 refs came back `offMainline`, 277 of 278 perf-lab commits had
 * no tree to digest, every series was cut to a single point — and the step
 * succeeded, wrote a well-formed file, and reported zero findings across the
 * board. Nothing in the run said otherwise.
 */
export const assertUsable = ({ order, corpus }) => {
  const positioned = order.positionedCount / Math.max(1, order.refCount);
  if (positioned < MIN_POSITIONED_FRACTION) {
    throw new Error(
      `Only ${order.positionedCount} of ${order.refCount} refs are on ${order.branch} and the mainline reads ${order.mainlineLength} commits long. ` +
        `The clone is not the history these measurements came from — a shallow checkout does this, and --filter=tree:0 does not deepen one. ` +
        `Refusing to report findings computed against it.`,
    );
  }

  const lengths = Object.values(corpus.series ?? {})
    .map((entry) =>
      entry.segments.reduce(
        (longest, segment) => Math.max(longest, segment.length),
        0,
      ),
    )
    .sort((left, right) => left - right);
  const median = lengths[lengths.length >> 1] ?? 0;
  if (median < MIN_MEDIAN_SEGMENT) {
    throw new Error(
      `The median series carries ${median} comparable points, under the ${MIN_MEDIAN_SEGMENT} the confirmed layer needs. ` +
        `Segments are cut where a case's workload changed or its digest is unknown, so this usually means the perf-lab clone is missing the commits that took the measurements. ` +
        `Refusing to report findings computed against it.`,
    );
  }
};

/**
 * What this run measured, as `caseId -> value`, from its own artifacts.
 *
 * V2 only, passing only, positive only — the same three filters the corpus
 * query applies, so the value judged is the value that will land in the
 * history. A failure has a duration, but it is the duration of a failure.
 *
 * Sharded runs write one payload per case per shard, and a case measured twice
 * collapses to the median, which is what the corpus does with rows sharing a
 * commit.
 */
export const runMeasurements = (payloadEntries = []) => {
  const byCase = new Map();
  for (const entry of payloadEntries) {
    const payload = entry?.payload ?? entry;
    if (payload?.engine !== "v2" || payload?.result !== "pass") continue;
    const caseId = String(payload.caseId ?? "").trim();
    const value = primaryMetricValue(payload);
    if (!caseId || !(value > 0)) continue;
    if (!byCase.has(caseId)) byCase.set(caseId, []);
    byCase.get(caseId).push(value);
  }
  return new Map(
    [...byCase].map(([caseId, values]) => [caseId, median(values)]),
  );
};

/**
 * Read them off disk, or answer `undefined` if there is nothing to read.
 *
 * `undefined` is not the same as an empty map: an empty map says this run
 * measured nothing and every case should go unjudged, while `undefined` says
 * the artifacts were not available and the corpus tail is all there is. A local
 * analysis over the history has no run of its own and takes the second path.
 */
const readRunMeasurements = async () => {
  const artifactDir = env("PERF_LAB_ARTIFACT_DIR");
  if (!artifactDir) {
    console.log(
      "Shadow: PERF_LAB_ARTIFACT_DIR is not set; the fast layer will judge the newest point of every series instead of this run's own measurements.",
    );
    return undefined;
  }
  try {
    const payloads = await readArtifactPayloads({
      artifactDir: resolve(artifactDir),
      includeSeed: false,
      allowEmpty: true,
    });
    const measured = runMeasurements(payloads);
    console.log(
      `Shadow: this run measured ${measured.size} cases on v2, from ${payloads.length} payloads in ${artifactDir}.`,
    );
    if (measured.size === 0) {
      // Every case will go unjudged and the fast layer will report nothing —
      // which is the correct answer to "what did this run measure" and looks
      // identical to a clean run in a count. Said out loud here, and `judged 0
      // of 0` in the job summary says it again, because a zero from an empty
      // input is the failure mode this whole step has hit before.
      console.warn(
        `Shadow: no usable v2 measurements in ${artifactDir}. The same-run layer will judge nothing this run; that is an empty input, not a quiet run.`,
      );
    }
    return measured;
  } catch (error) {
    // Not fatal, and not silent. Falling back to the corpus tail judges cases
    // this run never touched, which is a weaker result rather than a wrong one
    // — but it is a different result, and the log has to say which one this is.
    console.warn(
      `Shadow: could not read this run's measurements from ${artifactDir} (${error instanceof Error ? error.message : error}); falling back to the newest point of each series.`,
    );
    return undefined;
  }
};

/**
 * What the existing 20% gate flagged this run — and, when it flagged nothing,
 * which kind of nothing.
 *
 * This is the half of shadow mode that makes it shadow mode, and it was never
 * connected. `RELEASE_COMPARISON_PATH` pointed at `release-baseline.json`, the
 * released build's per-case values, which carries no verdict and no
 * `regressions` key. `comparison.regressions ?? []` read that as an empty list,
 * the file parsed fine so nothing was caught, and twenty-three runs recorded
 * `old: 0, agreed: 0` — a reconciliation between the new system and silence.
 *
 * So the three states are separated and reported. `no-comparison-file` and
 * `not-a-comparison-file` are plumbing failures. `no-release-baseline` is a
 * real state — the released commit can predate every measurement — in which the
 * old gate genuinely has nothing to say, and which still cannot be reconciled
 * against. Only `available` produces evidence, and the run ledger counts only
 * those.
 */
/**
 * Every seen-set recent runs uploaded, from the recovery directory.
 *
 * The cache the seen-set normally travels in fails two ways, and both were
 * measured rather than imagined. It forks, because entries are immutable and
 * the restore matches by prefix, so overlapping runs each save a lineage the
 * other lacks. And it misses: on 2026-08-09 the scheduled run logged `Cache not
 * found for input keys: perf-shadow-seen-`, read an empty seen-set, announced
 * 117 historical change points as new, and saved that back over 229 good keys.
 *
 * A union repairs both, because the seen-set is a set that only ever grows: no
 * merge rule is needed beyond taking everything. Tolerant of a missing or
 * malformed directory, which leaves the run exactly where it was before this
 * existed.
 */
export const readRecoveredSeen = async (dir) => {
  if (!dir) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const known = new Set();
  for (const entry of entries) {
    if (!entry.endsWith(SHADOW_SEEN_FILE_NAME)) {
      continue;
    }
    try {
      const parsed = JSON.parse(await readFile(resolve(dir, entry), "utf8"));
      for (const key of parsed?.known ?? []) {
        known.add(key);
      }
    } catch {
      // A copy that will not parse is one copy, not the run. Skipped.
    }
  }
  return [...known];
};

/**
 * Say where the seen-set came from, and shout when the cache lost it.
 *
 * The distinction this exists to make: an empty seen-set at the cold start is
 * correct and expected, and an empty seen-set because the cache missed is a run
 * about to re-announce the entire history as new. Both used to print the same
 * thing, which is nothing — the wipe on 2026-08-09 passed through a green step
 * and a well-formed artifact, and was found four days later by reading logs.
 */
export const reportSeenSources = ({ cached, recovered, seen }, log = console) => {
  const repaired = seen.length - (cached?.length ?? 0);
  if (cached === undefined && recovered.length > 0) {
    log.warn(
      `[perf-lab] the shadow seen-set cache missed and ${recovered.length} keys were recovered from recent run artifacts. ` +
        `Without that this run would have reported the whole recent history as new change points. ` +
        `The miss itself is worth investigating; the run is not affected.`,
    );
    return;
  }
  if (cached === undefined) {
    log.log(
      "Shadow seen-set: nothing cached and nothing recovered — treating this as the cold start. " +
        "Every change point below is a first sighting because nothing was on the record, not because it is new.",
    );
    return;
  }
  if (repaired > 0) {
    log.warn(
      `[perf-lab] the shadow seen-set cache returned ${cached.length} keys and recent run artifacts held ${repaired} more. ` +
        `Recovered; without them those ${repaired} change points would have been re-announced as new.`,
    );
    return;
  }
  log.log(
    `Shadow seen-set: ${seen.length} keys, cache complete against ${recovered.length} recovered.`,
  );
};

export const readOldGate = async () => {
  const path = resolve(
    env("RELEASE_COMPARISON_PATH", "release-comparison.json"),
  );
  let comparison;
  try {
    comparison = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const reason =
      error?.code === "ENOENT" ? "no-comparison-file" : "unreadable-comparison";
    console.warn(
      `Shadow: no old-gate verdict at ${path} (${reason}). This run cannot be reconciled and will not count toward acceptance G1.`,
    );
    return { flagged: [], available: false, reason, path };
  }

  if (!Array.isArray(comparison.regressions)) {
    // The shape says this is not the file it was meant to read. Named
    // separately from a missing file because this is the failure that already
    // happened: a real file, valid JSON, wrong file, silently answering "no
    // regressions".
    console.warn(
      `Shadow: ${path} carries no \`regressions\` list, so it is not a release comparison — it is probably the baseline file. This run cannot be reconciled and will not count toward acceptance G1.`,
    );
    return {
      flagged: [],
      available: false,
      reason: "not-a-comparison-file",
      path,
    };
  }

  if (comparison.available === false) {
    console.warn(
      `Shadow: the old gate had no release baseline this run, so it flagged nothing by construction. Recorded as unreconcilable rather than as agreement.`,
    );
    return {
      flagged: [],
      available: false,
      reason: "no-release-baseline",
      path,
    };
  }

  return {
    flagged: comparison.regressions.map((row) => row.caseId),
    available: true,
    reason: undefined,
    path,
    compared: comparison.counts?.compared,
  };
};

const main = async () => {
  const workDir = resolve(env("SHADOW_WORK_DIR", "shadow-work"));
  const outputPath = resolve(
    env("SHADOW_RESULT_PATH", SHADOW_RESULT_FILE_NAME),
  );
  const teableEeRepo = resolve(env("TEABLE_EE_REPO", "teable-ee-revision"));

  await mkdir(workDir, { recursive: true });
  const corpus = await refreshCorpus({ workDir, teableEeRepo });
  const order = JSON.parse(
    await readFile(resolve(workDir, "commit-order.json"), "utf8"),
  );
  const commitOf = new Map(
    Object.entries(order.ordinals ?? {}).map(([sha, ordinal]) => [
      ordinal,
      sha,
    ]),
  );
  assertUsable({ order, corpus });

  const measured = await readRunMeasurements();
  const runOrdinal = order.ordinals?.[env("PERF_LAB_TEABLE_EE_REF", "")];
  if (measured && !Number.isInteger(runOrdinal)) {
    // The history is still judged against — it just cannot be trimmed by
    // position. An unpositioned ref contributes nothing to the corpus either,
    // so the whole series is genuinely prior history; this says so rather than
    // leaving a reader to assume the trim happened.
    console.log(
      "Shadow: the commit under test is not positioned on the mainline, so this run contributed no corpus point and the whole series is history.",
    );
  }
  console.log(
    `Shadow: detecting over ${Object.keys(corpus.series ?? {}).length} series…`,
  );
  const analysis = analyse(corpus, {
    commitAt: (ordinal) => commitOf.get(ordinal),
    measured,
    runOrdinal,
  });

  const oldGate = await readOldGate();
  const oldFlagged = oldGate.flagged;

  // Only change points not reported before. The seen-set is persisted beside
  // the result and grows monotonically: a change point that stops being
  // detected because a fix landed has not been un-detected, and the fix is its
  // own change point.
  const seenPath = resolve(env("SHADOW_SEEN_PATH", SHADOW_SEEN_FILE_NAME));
  let cached;
  try {
    cached = JSON.parse(await readFile(seenPath, "utf8")).known ?? [];
  } catch {
    cached = undefined;
  }
  const recovered = await readRecoveredSeen(env("SHADOW_RECOVERY_DIR"));
  const seen = [...new Set([...recovered, ...(cached ?? [])])];
  reportSeenSources({ cached, recovered, seen });
  const separated = separateFresh(analysis.confirmed, seen);

  const reconciliation = reconcileRun({
    oldFlagged,
    newFlagged: analysis.fast.flagged.map((entry) => entry.key),
    confirmed: separated.fresh,
    unjudged: analysis.unjudged,
  });

  const result = {
    runId: env("GITHUB_RUN_ID") || undefined,
    teableEeRef: env("PERF_LAB_TEABLE_EE_REF") || undefined,
    fast: {
      flagged: analysis.fast.flagged.map((entry) => ({
        caseId: entry.key,
        ratio: Number(entry.ratio.toFixed(3)),
        ownBar: Number(entry.thresholdRatio.toFixed(3)),
      })),
      judged: analysis.fast.judged,
      skipped: analysis.fast.skipped,
      // Which point the fast layer judged. `run` means this run's own
      // measurements; `corpus-tail` means the newest point of each series,
      // which for a case this run did not measure is days old. The
      // reconciliation counts mean different things in the two modes, so the
      // mode travels with them.
      source: measured ? "run" : "corpus-tail",
      measured: measured ? measured.size : undefined,
    },
    confirmed: separated.fresh,
    confirmedRepeated: separated.counts.repeated,
    // How many change points were already on the record when this run started.
    // Zero means the seen-set was empty and every change point below is a first
    // sighting only because nothing had been recorded before — the cold start,
    // which is a different kind of run and must not be averaged in with the
    // others when the confirmed layer's rate is quoted.
    seenBefore: seen.length,
    // Whether the old gate's verdict was actually read this run. Without it
    // every reconciliation count is zero and reads exactly like a run where the
    // old gate was quiet — which is how twenty-three runs of empty
    // reconciliation passed for data.
    oldGate: {
      available: oldGate.available,
      reason: oldGate.reason,
      flagged: oldGate.flagged.length,
      compared: oldGate.compared,
    },
    reconciliation,
    coverage: { tested: analysis.tested, unjudged: analysis.unjudged.length },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  await mkdir(dirname(seenPath), { recursive: true });
  await writeFile(
    seenPath,
    `${JSON.stringify({ known: separated.known }, null, 2)}\n`,
  );
  const movers = separated.fresh.reduce((tally, point) => {
    tally[point.mover] = (tally[point.mover] ?? 0) + 1;
    return tally;
  }, {});
  console.log(
    `Shadow analysis: ${result.fast.flagged.length} flagged this run ` +
      `(judging ${result.fast.source === "run" ? `this run's ${measured.size} measurements` : "the newest point of each series"}), ` +
      `${separated.counts.fresh} new confirmed change points ` +
      `[${
        Object.entries(movers)
          .map(([mover, count]) => `${count} ${mover}`)
          .join(", ") || "none"
      }] ` +
      `(${separated.counts.repeated} already reported), ` +
      `${analysis.unjudged.length} cases not judgeable; ` +
      `old gate flagged ${oldFlagged.length} (agreed ${reconciliation.counts.agreed}, ` +
      `old only ${reconciliation.counts.oldOnly}, new only ${reconciliation.counts.newOnly}) → ${outputPath}`,
  );
};

// Only when run as a script. Importing this module must not fire a Teable
// fetch — `analyse` is exported so it can be tested and reused, and a bare
// `main()` at module scope turns `import { analyse }` into a full corpus
// rebuild over the network. `release-baseline-model.mjs` carries the same
// warning; it was written after someone hit this, and it was ignored here once
// already, which cost an afternoon and produced a confidently wrong diagnosis
// blaming the detection algorithm.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error) => {
    console.error(
      `Shadow analysis failed: ${error instanceof Error ? error.stack || error.message : error}`,
    );
    // Exiting non-zero, which this used to avoid. It cannot fail the run any
    // more: the step carries `continue-on-error` and sits after everything the
    // run depends on, so the only thing a non-zero exit changes is that the
    // failure is legible.
    //
    // And it has to be legible, because the seen-set save is gated on this
    // step's `outcome`. Swallowing the error made that gate always open — a run
    // whose analysis refused to produce anything still wrote state back and
    // still read as successful in the Actions UI. The gate was written for a
    // reason; this is what makes it work.
    process.exitCode = 1;
  });
}
