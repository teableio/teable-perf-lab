// Compute every case's config digest at every perf-lab commit that produced
// measurements.
//
// Reads perf-lab commit SHAs on stdin (Performance Track's `Commit SHA`, which
// is the workflow's `GITHUB_SHA` — this repo, not teable-ee) and writes
// `case-digests.json`. `commit-order-model.mjs` consumes it through
// `segmentSeries` to cut each series where its workload changed.
//
// Two things make this cheap enough to run over the whole history:
//
//   - blobs are read once, not once per commit. A case file changes a median of
//     one time across the history, so 266 commits x 393 cases resolve to only a
//     few hundred distinct blobs. One `cat-file --batch` reads all of them.
//   - identical digest vectors are stored once. Most commits changed no case at
//     all, so the artifact keeps distinct snapshots and points commits at them.
//
// The naive shape — `git show <sha>:<path>` per case per commit — is over a
// hundred thousand process spawns for the same answer.

import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { env } from "./env.mjs";
import {
  CASE_FILE_SUFFIX,
  DIGEST_VERSION,
  digestAllCases,
} from "./case-config-digest-model.mjs";

const run = promisify(execFile);

export const CASE_DIGESTS_FILE_NAME = "case-digests.json";

const REPO = resolve(env("PERF_LAB_REPO", "."));
const MAX_BUFFER = 256 * 1024 * 1024;

const git = async (args) => {
  const { stdout } = await run("git", ["-C", REPO, ...args], {
    maxBuffer: MAX_BUFFER,
  });
  return stdout;
};

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
};

/**
 * Case files and their blob ids at one commit.
 *
 * `ls-tree -r` walks the tree without checking anything out, so this works on
 * commits far from HEAD and leaves the working tree alone.
 */
const treeAt = async (sha) => {
  let stdout;
  try {
    stdout = await git(["ls-tree", "-r", sha, "--", "cases/"]);
  } catch {
    return undefined; // Commit not in this clone.
  }
  const paths = new Map();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    // "<mode> blob <sha>\t<path>"
    const tab = line.indexOf("\t");
    const path = line.slice(tab + 1);
    if (!path.endsWith(CASE_FILE_SUFFIX)) continue;
    paths.set(path, line.slice(0, tab).split(" ")[2]);
  }
  return paths;
};

/**
 * Read many blobs in one process.
 *
 * `cat-file --batch` answers "<sha> blob <size>\n<contents>\n" per request, so
 * the reply is walked by byte length rather than split on newlines — case files
 * contain newlines, and splitting would desynchronise the stream.
 */
const readBlobs = async (shas) => {
  const contents = new Map();
  if (shas.length === 0) return contents;

  const child = run("git", ["-C", REPO, "cat-file", "--batch"], {
    maxBuffer: MAX_BUFFER,
    encoding: "buffer",
  });
  child.child.stdin.end(`${shas.join("\n")}\n`);
  const { stdout } = await child;

  let offset = 0;
  for (const sha of shas) {
    const newline = stdout.indexOf(0x0a, offset);
    const header = stdout.toString("utf8", offset, newline);
    offset = newline + 1;
    const [, type, size] = header.split(" ");
    if (type !== "blob") continue; // "<sha> missing" carries no body.
    const length = Number(size);
    contents.set(sha, stdout.toString("utf8", offset, offset + length));
    offset += length + 1; // Trailing newline after the body.
  }
  return contents;
};

const main = async () => {
  const outputPath = resolve(env("CASE_DIGESTS_PATH", CASE_DIGESTS_FILE_NAME));
  const commits = [
    ...new Set(
      (await readStdin())
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
  if (commits.length === 0) {
    throw new Error(
      "No commits on stdin. Pipe one perf-lab Commit SHA per line.",
    );
  }

  const trees = new Map();
  const unresolved = [];
  for (const sha of commits) {
    const tree = await treeAt(sha);
    if (tree) trees.set(sha, tree);
    else unresolved.push(sha);
  }

  const blobShas = [
    ...new Set([...trees.values()].flatMap((tree) => [...tree.values()])),
  ];
  const blobs = await readBlobs(blobShas);

  // Every case id that ever existed across these commits. Deriving it from the
  // trees rather than from HEAD keeps deleted cases in the history where their
  // measurements still are.
  const caseIds = [
    ...new Set(
      [...trees.values()].flatMap((tree) =>
        [...tree.keys()].map((path) =>
          path.slice("cases/".length, -CASE_FILE_SUFFIX.length),
        ),
      ),
    ),
  ].sort();

  const snapshots = [];
  const snapshotIndex = new Map();
  const byCommit = {};
  for (const [sha, tree] of trees) {
    const readFile = (path) => blobs.get(tree.get(path));
    const digests = digestAllCases({ caseIds, readFile });
    const key = JSON.stringify(digests);
    let index = snapshotIndex.get(key);
    if (index === undefined) {
      index = snapshots.length;
      snapshots.push(digests);
      snapshotIndex.set(key, index);
    }
    byCommit[sha] = index;
  }

  const artifact = {
    digestVersion: DIGEST_VERSION,
    commitCount: trees.size,
    caseCount: caseIds.length,
    snapshotCount: snapshots.length,
    unresolved,
    snapshots,
    byCommit,
  };

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact)}\n`);

  // Only digests the case actually had count as a change. Every case is absent
  // before it was written, and counting that absence as a change reports every
  // case as having changed workload — true, and useless.
  const changed = new Set();
  for (const caseId of caseIds) {
    const seen = new Set();
    for (const snapshot of snapshots) {
      if (snapshot[caseId] !== undefined) seen.add(snapshot[caseId]);
    }
    if (seen.size > 1) changed.add(caseId);
  }
  console.log(
    `Case digests: ${trees.size}/${commits.length} commits, ${caseIds.length} cases, ` +
      `${snapshots.length} distinct snapshots, ${blobShas.length} blobs read; ` +
      `${changed.size} cases changed workload at least once → ${outputPath}`,
  );
  if (unresolved.length > 0) {
    console.warn(
      `${unresolved.length} commits are not in ${REPO}; series at those commits will be cut rather than joined.`,
    );
  }
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
