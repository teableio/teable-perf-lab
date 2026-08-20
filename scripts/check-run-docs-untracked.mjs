#!/usr/bin/env node
// Local operating tooling must not be committed to this repository.
//
// This repository is public, and running a case locally means driving a private
// product checkout. Everything about that — the instructions and the scripts
// that carry them out — describes a layout and a workflow that only exist for
// one deployment, so none of it is published here; it is handed over through
// the team's own channel.
//
// The rule is structural rather than a list of forbidden words: nothing under
// .agents/skills may be tracked, and no tracked file may spell out a run of
// this repository's lab runner. Nothing here has to name what it keeps out.

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

// 1. The skill directory, documents and scripts alike.
for (const file of tracked(".agents/skills/**")) {
  failures.push(`${file} is tracked; local skill tooling must stay out`);
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
    "Local run tooling must not be committed to this public repository.",
  );
  console.error(
    "Keep the skill out of the repository and hand it over through the team's own channel.",
  );
  for (const failure of failures) {
    console.error(`  ${failure}`);
  }
  process.exit(1);
}

console.log("Local run tooling is untracked");
