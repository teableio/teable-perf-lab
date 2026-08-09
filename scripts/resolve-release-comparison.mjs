// Write the old gate's verdict to disk, so something other than the card can
// read it.
//
// The 20% release comparison has always been computed at render time, inside
// `buildPerfSummaryCard`, and thrown away with the card. That was fine while
// the only consumer was the card. It stopped being fine when shadow mode was
// built to reconcile against it: the shadow step was pointed at
// `release-baseline.json` — the *baseline*, which carries the released build's
// per-case values and no verdict at all — and read `comparison.regressions ??
// []` off a file that has no `regressions` key. The file exists and parses, so
// the `try/catch` never fired, and every shadow run since has reported
// `old: 0, agreed: 0`: not a run where the old gate was quiet, a run where
// nobody asked it. Twenty-three runs of reconciliation data that reconciled
// nothing.
//
// So the verdict is resolved here, into its own file, from the same two inputs
// the card uses and through the same function — not a second implementation of
// the 20% rule, which would drift from the card and produce a reconciliation
// between two things that were never the same gate.
//
// Written deliberately as its own step rather than as an extra output of the
// summary writer. The summary is rendered in two places for two destinations,
// both of which are being changed by other work; a file the shadow depends on
// should not be a side effect of whichever one happens to run.

import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { env, requiredEnv } from "./env.mjs";
import { buildReleaseComparison } from "./full-run-comparison-model.mjs";
import { RELEASE_BASELINE_FILE_NAME } from "./release-baseline-model.mjs";
import {
  readArtifactPayloads,
  readJsonFileIfExists,
} from "./perf-artifact-read-model.mjs";

export const RELEASE_COMPARISON_FILE_NAME = "release-comparison.json";

const main = async () => {
  const artifactDir = resolve(requiredEnv("PERF_LAB_ARTIFACT_DIR"));
  const baselinePath = resolve(
    env(
      "PERF_LAB_RELEASE_BASELINE_PATH",
      join(artifactDir, RELEASE_BASELINE_FILE_NAME),
    ),
  );
  const outputPath = resolve(
    env(
      "PERF_LAB_RELEASE_COMPARISON_PATH",
      join(artifactDir, RELEASE_COMPARISON_FILE_NAME),
    ),
  );

  const payloads = await readArtifactPayloads({
    artifactDir,
    includeSeed: false,
    allowEmpty: true,
  });
  const baseline = await readJsonFileIfExists(baselinePath);

  const comparison = buildReleaseComparison({
    payloads: payloads.map((entry) => entry.payload),
    baseline,
  });

  // `available: false` is a real state and is written out as one. The released
  // commit can predate a measurement, or the launch row can be missing, and in
  // both cases the old gate has nothing to say this run — which the shadow has
  // to be able to tell apart from "the file was never written", because only
  // one of those is a plumbing failure.
  const result = {
    ...comparison,
    baselineRead: Boolean(baseline),
    baselinePath,
    payloadCount: payloads.length,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    `Release comparison: ${comparison.available ? `${comparison.counts.slower} regressions of ${comparison.counts.compared} compared` : "no baseline to compare against"}` +
      `, ${payloads.length} payloads read → ${outputPath}`,
  );
};

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error) => {
    console.error(
      error instanceof Error ? error.stack || error.message : error,
    );
    process.exitCode = 1;
  });
}
