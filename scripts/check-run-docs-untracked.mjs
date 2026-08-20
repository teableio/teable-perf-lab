#!/usr/bin/env node
// Local operating instructions must not be committed to this repository.
//
// This repository is public, and running a case locally means driving a
// private product checkout. Instructions for that accrete details that are
// true only of one deployment - internal build and deployment switches,
// instance configuration - and one such switch did reach this repository and
// sat in it for two months. The skill's scripts are committed because they
// carry none of that; the prose is not.
//
// So the rule is structural rather than a list of forbidden words: a run
// command for this repository's lab runner must not appear in any tracked
// file, and the skill documents must not be tracked at all. Nothing here has
// to name what it is keeping out.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));

// The lab runner invocation. A tracked file containing one is documenting how
// to run locally, wherever it lives.
const RUN_COMMAND = /vitest run\s+--config\s+\.\/vitest-[a-z0-9-]*\.config\.ts/;

const tracked = (...patterns) =>
  execFileSync("git", ["ls-files", "-z", ...patterns], {
    cwd: repoRoot,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);

const failures = [];

// 1. The skill documents themselves.
for (const file of tracked(".agents/skills/*/*.md")) {
  failures.push(`${file} is tracked; local skill instructions must stay out`);
}

// 2. Anything else that spells out a local run.
for (const file of tracked("*.md")) {
  const source = readFileSync(new URL(file, `file://${repoRoot}`), "utf8");
  for (const [, block] of source.matchAll(/```bash\n([\s\S]*?)```/g)) {
    if (!RUN_COMMAND.test(block)) continue;
    failures.push(`${file} documents a local run command`);
    break;
  }
}

if (failures.length > 0) {
  console.error(
    "Local run instructions must not be committed to this public repository.",
  );
  console.error(
    "Keep them in the gitignored skill document and hand them over through the team's own channel; commit only the scripts.",
  );
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log("Local run instructions are untracked");
