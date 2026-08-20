// Resolve teable-ee refs to positions along the mainline.
//
// Reads refs on stdin (one per line, as they appear in Performance Track's
// `Teable EE Ref`) and writes `commit-order.json`: an ordinal for every ref that
// sits on the mainline first-parent chain, and a reason for every ref that does
// not. `commit-order-model.mjs` holds the rules and the reasoning; this file is
// only the git and filesystem half.
//
// Only the refs actually asked about are written out. The full chain is ~2,700
// commits and the history references ~570 of them, so storing the whole map
// would be four times the size for no reader.
//
// The clone has to be current or refs will be reported unresolved that are not.
// Refs that stay unresolved after a fetch are real: force-pushed or deleted
// branches. 42 of them were still missing after a full fetch on 2026-08-07,
// carrying 219 rows between them.
//
// Resolvability is checked with one `cat-file --batch-check` over the whole
// list, not a spawn per ref. Beyond being ~570x fewer processes, the per-ref
// shell loop this replaced silently mis-reported: `git cat-file -e` exits 128
// rather than 1 on an unparseable name, and the loop that first produced these
// numbers counted 539 refs resolvable where the true figure is 516.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { env } from "./env.mjs";
import { isPinnedCommit, MAINLINE_BRANCH } from "./commit-order-model.mjs";

const run = promisify(execFile);

export const COMMIT_ORDER_FILE_NAME = "commit-order.json";

const DEFAULT_REPO = "../../product/teable-ee";

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const git = async (repo, args, { maxBuffer = 64 * 1024 * 1024 } = {}) => {
  const { stdout } = await run("git", ["-C", repo, ...args], { maxBuffer });
  return stdout;
};

/**
 * Mainline commits, oldest first.
 *
 * `--first-parent` is the load-bearing flag. Without it the list also contains
 * every commit merged in from a branch, and a PR branch's own commits would get
 * positions as if they had been on the mainline all along.
 */
const readMainline = async (repo, branch) => {
  // The commit date travels with the position. Incident records need to say how
  // long a regression stood, and the only clock that is a fact about the code
  // rather than about when this happened to run is the mainline's own — so it
  // is read here, once, alongside the ordering it belongs to.
  //
  // `--timestamp` rather than `--format=%cI`, and the difference is a
  // disclosure rule rather than a preference: this clone is private and this
  // repository's logs are public, so `check-private-repo-git-reads.mjs` allows
  // `rev-list` and forbids every flag that can make it print prose, `--format`
  // included. `--timestamp` prefixes each line with the committer date as a
  // Unix second and nothing else, which is the one route to a date that cannot
  // also emit a commit subject.
  const stdout = await git(repo, [
    "rev-list",
    "--first-parent",
    "--reverse",
    "--timestamp",
    branch,
  ]);
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [seconds, sha] = line.split(" ");
      const at = Number(seconds);
      return {
        sha,
        committedAt: Number.isFinite(at)
          ? new Date(at * 1000).toISOString()
          : undefined,
      };
    });
};

/**
 * Which of these SHAs the clone can resolve, in one pass.
 *
 * `cat-file --batch-check` takes the whole list on stdin and answers for each,
 * which turns ~570 process spawns into one. It prints "<sha> missing" for the
 * ones it does not have.
 */
const readResolvable = async (repo, shas) => {
  if (shas.length === 0) {
    return new Set();
  }
  const child = run("git", ["-C", repo, "cat-file", "--batch-check"], {
    maxBuffer: 16 * 1024 * 1024,
  });
  child.child.stdin.end(`${shas.map((sha) => `${sha}^{commit}`).join("\n")}\n`);
  const { stdout } = await child;

  const resolvable = new Set();
  const lines = stdout.split("\n").filter(Boolean);
  for (const [index, line] of lines.entries()) {
    if (!line.endsWith(" missing") && !line.includes(" ambiguous")) {
      resolvable.add(shas[index]);
    }
  }
  return resolvable;
};

const main = async () => {
  const repo = resolve(env("TEABLE_EE_REPO", DEFAULT_REPO));
  const branch = env("TEABLE_EE_MAINLINE", MAINLINE_BRANCH);
  const outputPath = resolve(env("COMMIT_ORDER_PATH", COMMIT_ORDER_FILE_NAME));

  const refs = [
    ...new Set(
      (await readStdin())
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (refs.length === 0) {
    throw new Error(
      "No refs on stdin. Pipe one Teable EE Ref per line, e.g. from the corpus query.",
    );
  }

  const mainline = await readMainline(repo, branch);
  const position = new Map(
    mainline.map((commit, index) => [commit.sha, index]),
  );
  const dateOf = new Map(
    mainline.map((commit) => [commit.sha, commit.committedAt]),
  );
  const head = mainline[mainline.length - 1]?.sha;
  const headCommittedAt = mainline[mainline.length - 1]?.committedAt;

  const pinned = refs.filter((ref) => isPinnedCommit(ref));
  const resolvable = await readResolvable(
    repo,
    pinned.filter((sha) => !position.has(sha)),
  );

  const ordinals = {};
  const excluded = {};
  for (const ref of refs) {
    if (!isPinnedCommit(ref)) {
      excluded[ref] = "unpinned";
      continue;
    }
    const ordinal = position.get(ref);
    if (ordinal !== undefined) {
      ordinals[ref] = ordinal;
      continue;
    }
    excluded[ref] = resolvable.has(ref) ? "offMainline" : "unresolved";
  }

  const counts = Object.values(excluded).reduce((tally, reason) => {
    tally[reason] = (tally[reason] ?? 0) + 1;
    return tally;
  }, {});
  const positioned = Object.keys(ordinals);
  const span = positioned.map((sha) => ordinals[sha]).sort((a, b) => a - b);

  const artifact = {
    branch,
    head,
    // The newest mainline commit's own date, used as "now" when an incident is
    // still open. Wall-clock would make the same history produce a different
    // answer on every run.
    headCommittedAt,
    mainlineLength: mainline.length,
    refCount: refs.length,
    positionedCount: positioned.length,
    excludedCounts: counts,
    span:
      span.length > 0
        ? { from: span[0], to: span[span.length - 1] }
        : undefined,
    ordinals,
    // Only for the refs that were positioned; the whole chain is ~2,700 commits
    // and nothing reads the dates of the ones no measurement mentions.
    committedAt: Object.fromEntries(
      positioned.map((sha) => [sha, dateOf.get(sha)]),
    ),
    excluded,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);

  const excludedSummary =
    Object.entries(counts)
      .map(([reason, n]) => `${n} ${reason}`)
      .join(", ") || "none excluded";
  console.log(
    `Commit order: ${positioned.length}/${refs.length} refs on ${branch} (${excludedSummary}); mainline ${mainline.length} commits, head ${head.slice(0, 10)}${
      span.length > 0 ? `, span #${span[0]}..#${span[span.length - 1]}` : ""
    } → ${outputPath}`,
  );

  if (counts.unresolved > 0) {
    console.warn(
      `${counts.unresolved} refs could not be resolved in ${repo}. Run \`git -C ${repo} fetch --all\` and retry; any that remain were force-pushed or deleted.`,
    );
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
