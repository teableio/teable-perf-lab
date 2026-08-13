// Add this run to the shadow ledger and say where G1 and G2 stand.
//
// Runs right after the shadow analysis, on the same terms: it may not fail the
// run, it sits after everything the run depends on, and it exits non-zero when
// it cannot do its job so that the failure is legible rather than a quiet
// success.
//
// The ledger travels in the same cache entry as the seen-set. Both are the same
// kind of thing — state that only means something accumulated — and losing one
// without the other would leave a run count that disagrees with the change
// points it is counting.
//
// The cache alone cannot hold it, though, so the ledger is the union of the
// cached copy with whatever recent runs published as artifacts. See
// `mergeLedgers` for why: overlapping runs fork the cache entry and each drops
// the other's records, which was walking G1 backwards before this was fixed.
// The cache is the fast path; the artifacts are the repair.
//
// A run that produced no shadow result is not recorded. G1 asks for ten runs of
// the new system running alongside the old one, and a run whose analysis
// refused to produce anything did not do that; counting it would make the ten
// arrive sooner and mean less.

import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { env } from "./env.mjs";
import { SHADOW_RESULT_FILE_NAME } from "./run-shadow-analysis.mjs";
import {
  appendRun,
  assessShadow,
  mergeLedgers,
  renderShadowProgress,
  runRecord,
} from "./shadow-accumulation-model.mjs";

export const SHADOW_LEDGER_FILE_NAME = "shadow-runs.json";

const readJsonIfExists = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return fallback;
  }
};

/**
 * Every `shadow-runs.json` under the recovery directory, one per recent run.
 *
 * Tolerant on purpose. This is a repair path, and a run that cannot read it is
 * no worse off than a run from before it existed — so a missing directory, an
 * unreadable file or a malformed one is skipped rather than raised. What is not
 * tolerated is silence: `main` reports how many copies were found and how many
 * runs they put back, because "recovery found nothing" and "recovery was not
 * needed" are exactly the two readings that must not be confused.
 */
const readRecoveredLedgers = async (dir) => {
  if (!dir) {
    return [];
  }
  let entries;
  try {
    entries = await readdir(dir, { recursive: true });
  } catch {
    return [];
  }
  const ledgers = [];
  for (const entry of entries) {
    if (!entry.endsWith(SHADOW_LEDGER_FILE_NAME)) {
      continue;
    }
    const parsed = await readJsonIfExists(resolve(dir, entry), undefined);
    if (Array.isArray(parsed?.runs)) {
      ledgers.push(parsed.runs);
    }
  }
  return ledgers;
};

const main = async () => {
  const resultPath = resolve(
    env("SHADOW_RESULT_PATH", SHADOW_RESULT_FILE_NAME),
  );
  const ledgerPath = resolve(
    env("SHADOW_LEDGER_PATH", SHADOW_LEDGER_FILE_NAME),
  );

  // Read rather than tolerated-missing: this script only runs when the analysis
  // step succeeded, so a missing result here means the two disagree about what
  // happened, and that is worth a non-zero exit.
  const result = JSON.parse(await readFile(resultPath, "utf8"));

  const cached = (await readJsonIfExists(ledgerPath, { runs: [] })).runs ?? [];
  const recoveryDir = env("SHADOW_RECOVERY_DIR");
  const recovered = await readRecoveredLedgers(recoveryDir);
  // Cached last, so it wins a tie on `at` against a copy of the same run.
  const ledger = mergeLedgers([...recovered, cached]);
  const cachedIds = new Set(cached.map((entry) => entry?.runId));
  const repaired = ledger.filter((entry) => !cachedIds.has(entry?.runId)).length;

  if (recovered.length > 0) {
    console.log(
      `Shadow ledger: merged ${recovered.length} recovered copies into ${cached.length} cached runs; ` +
        `${repaired} run${repaired === 1 ? "" : "s"} the cache had lost to a concurrent write.`,
    );
  } else if (recoveryDir) {
    // Not an error, and not nothing either. The cache forks under concurrency,
    // so a count resting on it alone is a lower bound rather than a number.
    console.warn(
      `Shadow ledger: no recovered copies under ${recoveryDir}. The count below rests on the cache alone and may be short.`,
    );
  }

  const record = runRecord({
    result,
    runId: env("GITHUB_RUN_ID") || undefined,
    teableEeRef: env("PERF_LAB_TEABLE_EE_REF") || undefined,
    // The workflow knows whether the dispatch asked for every case. Inferring
    // it from how many cases were measured would classify a full run with a
    // dead shard as a partial dispatch, which is a different failure with a
    // different response.
    fullRun: env("PERF_LAB_CASE_FILTER_IS_ALL") === "true",
    at: new Date().toISOString(),
  });

  const updated = appendRun(ledger, record);
  await mkdir(dirname(ledgerPath), { recursive: true });
  await writeFile(
    ledgerPath,
    `${JSON.stringify({ runs: updated }, null, 2)}\n`,
  );

  const progress = renderShadowProgress(updated);
  console.log(
    `Shadow ledger: recorded run ${record.runId ?? "(no id)"}` +
      `${record.fullRun ? "" : " (not a full run — does not count toward G1)"} → ${ledgerPath}\n${progress}`,
  );

  const summaryPath = env("GITHUB_STEP_SUMMARY");
  if (summaryPath) {
    await writeFile(
      summaryPath,
      `### Shadow validation progress\n\n${progress}\n\n`,
      { flag: "a" },
    );
  }

  const assessment = assessShadow(updated);
  if (assessment.g1.met && assessment.g2.met) {
    console.log(
      "G1 and G2 are met. G3 — the hand review of everything the old gate flagged and the new system did not — is what remains before anything switches.",
    );
  }
};

if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  main().catch((error) => {
    console.error(
      `Shadow ledger failed: ${error instanceof Error ? error.stack || error.message : error}`,
    );
    process.exitCode = 1;
  });
}
