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
// nothing — not a reason to lose a run's results.

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { env } from "./env.mjs";
import {
  benjaminiHochberg,
  detectChangePointsWindowed,
} from "./change-point-model.mjs";
import { pairedSeries } from "./control-channel-model.mjs";
import { measurabilityOf } from "./measurability-model.mjs";
import { checkRun } from "./fast-check-model.mjs";
import { reconcileRun } from "./shadow-comparison-model.mjs";

const execFileAsync = promisify(execFile);

export const SHADOW_RESULT_FILE_NAME = "shadow-analysis.json";

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

const run = async (command, args, options = {}) => {
  const { stdout } = await execFileAsync(command, args, {
    maxBuffer: 256 * 1024 * 1024,
    ...options,
  });
  return stdout;
};

/**
 * Rebuild the ordering and digest inputs, then the corpus, into the workspace.
 *
 * Every path is under `workDir`, which CI discards when the run ends. Nothing
 * is written into the repository.
 */
const refreshCorpus = async ({ workDir, teableEeRepo }) => {
  const orderPath = resolve(workDir, "commit-order.json");
  const digestPath = resolve(workDir, "case-digests.json");
  const corpusPath = resolve(workDir, "perf-corpus.json");

  const refs = await run("node", [
    resolve("scripts/list-corpus-refs.mjs"),
    "--teable-ee",
  ]);
  await run("node", [resolve("scripts/resolve-commit-order.mjs")], {
    input: refs,
    env: {
      ...process.env,
      TEABLE_EE_REPO: teableEeRepo,
      COMMIT_ORDER_PATH: orderPath,
    },
  });

  const perfRefs = await run("node", [
    resolve("scripts/list-corpus-refs.mjs"),
    "--perf-lab",
  ]);
  await run("node", [resolve("scripts/resolve-case-digests.mjs")], {
    input: perfRefs,
    env: { ...process.env, CASE_DIGESTS_PATH: digestPath },
  });

  await run("node", [resolve("scripts/build-perf-corpus.mjs")], {
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
 * The fast layer judges the newest point of each series against that case's own
 * history. The confirmed layer looks at the whole series, on the V1-paired
 * values where a control exists, and applies one FDR correction across every
 * hypothesis tested.
 */
export const analyse = (
  corpus,
  { analysisWindow = DEFAULT_ANALYSIS_WINDOW } = {},
) => {
  const series = corpus.series ?? {};
  const fastCases = {};
  const unjudged = [];
  const points = [];
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

    fastCases[entry.caseId] = {
      history: values.slice(0, -1),
      latest: values[values.length - 1],
    };

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
    for (const point of found.points) {
      points.push({
        caseId: entry.caseId,
        beforeCommit: recent[point.index - 1]?.[0],
        afterCommit: recent[point.index]?.[0],
        ratio: Math.exp(point.shift),
        pValue: point.pValue,
        paired: Boolean(control),
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
  return {
    fast,
    confirmed,
    unjudged,
    tested,
    candidates: points.length,
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
  const analysis = analyse(corpus);

  // What the existing gate flagged this run, so the two can be reconciled. Read
  // from the artifact the current report already writes; absent, the shadow
  // still records its own findings and the reconciliation is simply empty.
  let oldFlagged = [];
  try {
    const comparison = JSON.parse(
      await readFile(
        resolve(env("RELEASE_COMPARISON_PATH", "release-comparison.json")),
        "utf8",
      ),
    );
    oldFlagged = (comparison.regressions ?? []).map((row) => row.caseId);
  } catch {
    oldFlagged = [];
  }

  const reconciliation = reconcileRun({
    oldFlagged,
    newFlagged: analysis.fast.flagged.map((entry) => entry.key),
    confirmed: analysis.confirmed,
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
    },
    confirmed: analysis.confirmed,
    reconciliation,
    coverage: { tested: analysis.tested, unjudged: analysis.unjudged.length },
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `Shadow analysis: ${result.fast.flagged.length} flagged this run, ` +
      `${analysis.confirmed.length} confirmed change points, ` +
      `${analysis.unjudged.length} cases not judgeable; ` +
      `old gate flagged ${oldFlagged.length} (agreed ${reconciliation.counts.agreed}, ` +
      `old only ${reconciliation.counts.oldOnly}, new only ${reconciliation.counts.newOnly}) → ${outputPath}`,
  );
};

main().catch((error) => {
  // Never fail the run. The existing report is what the team depends on today.
  console.error(
    `Shadow analysis failed, continuing: ${error instanceof Error ? error.stack || error.message : error}`,
  );
});
