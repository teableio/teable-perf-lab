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

import { spawn } from "node:child_process";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
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
 * The fast layer judges the newest point of each series against that case's own
 * history. The confirmed layer looks at the whole series, on the V1-paired
 * values where a control exists, and applies one FDR correction across every
 * hypothesis tested.
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
  } = {},
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
      const beforeOrdinal = recent[point.index - 1]?.[0];
      const afterOrdinal = recent[point.index]?.[0];
      points.push({
        caseId: entry.caseId,
        beforeCommit: commitAt(beforeOrdinal) ?? `#${beforeOrdinal}`,
        afterCommit: commitAt(afterOrdinal) ?? `#${afterOrdinal}`,
        beforeOrdinal,
        afterOrdinal,
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
  const order = JSON.parse(
    await readFile(resolve(workDir, "commit-order.json"), "utf8"),
  );
  const commitOf = new Map(
    Object.entries(order.ordinals ?? {}).map(([sha, ordinal]) => [
      ordinal,
      sha,
    ]),
  );
  console.log(
    `Shadow: detecting over ${Object.keys(corpus.series ?? {}).length} series…`,
  );
  const analysis = analyse(corpus, {
    commitAt: (ordinal) => commitOf.get(ordinal),
  });

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

  // Only change points not reported before. The seen-set is persisted beside
  // the result and grows monotonically: a change point that stops being
  // detected because a fix landed has not been un-detected, and the fix is its
  // own change point.
  const seenPath = resolve(env("SHADOW_SEEN_PATH", SHADOW_SEEN_FILE_NAME));
  let seen = [];
  try {
    seen = JSON.parse(await readFile(seenPath, "utf8")).known ?? [];
  } catch {
    seen = [];
  }
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
    },
    confirmed: separated.fresh,
    confirmedRepeated: separated.counts.repeated,
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
  console.log(
    `Shadow analysis: ${result.fast.flagged.length} flagged this run, ` +
      `${separated.counts.fresh} new confirmed change points ` +
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
    // Never fail the run. The existing report is what the team depends on.
    console.error(
      `Shadow analysis failed, continuing: ${error instanceof Error ? error.stack || error.message : error}`,
    );
  });
}
