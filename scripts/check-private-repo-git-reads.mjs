// Nothing may ask the teable-ee clone a question whose answer is prose.
//
// teable-perf-lab is public and its CI logs are public; teable-ee is not. The
// disclosure line the project has always drawn is that a bare SHA is fine and a
// commit subject is not — a SHA is an opaque identifier, a subject is a sentence
// about what the private product is doing this week.
//
// The shadow analysis needs teable-ee only to put commits in order, and it is
// fetched with `--filter=tree:0`: no trees, no blobs, not a byte of source on
// the runner. But commit objects carry their own messages and no filter removes
// that, so the subjects are on disk whether or not anything reads them. Today
// nothing does. The exposure is one debugging line away — `git log --oneline`
// while chasing an ordering bug prints straight into a public log, exits zero,
// and looks like every other successful step.
//
// So this check fixes the shape of the access rather than trusting each future
// edit: a short allowlist of subcommands whose output is SHAs and counts, and a
// denylist of the flags that turn one of those into a printer of prose.
//
// What it does not do, stated so nobody reads more into a green tick: it is a
// static read of source text. It catches the accident it was built for — a
// plainly written git call added to this path. It does not catch a command
// assembled from variables at runtime, a shell indirection, or a deliberate
// attempt to get around it. It is a guard rail, not a sandbox.

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";

const WORKFLOW = ".github/workflows/teable-ee-e2e-perf.yml";

// How the private clone is named, in both the workflow and the scripts.
const PRIVATE_REPO_TOKENS = ["teable-ee-revision", "TEABLE_EE_REPO"];

/**
 * Files allowed to run git against the private clone.
 *
 * A file joining this list is the moment to think about disclosure, which is
 * why the list is here rather than inferred. `run-shadow-analysis.mjs` names
 * `TEABLE_EE_REPO` but only passes it down as an environment variable and
 * spawns no git of its own; if that ever changes it lands here first.
 */
const ALLOWED_SCRIPTS = new Set(["scripts/resolve-commit-order.mjs"]);

// Every source directory, not a list of the files known to matter today. A
// named list was the first version of this and it had the hole the check exists
// to close: a new file naming the private clone would not have been on it, and
// would have been skipped rather than flagged.
const SOURCE_DIRECTORIES = ["scripts", "framework"];
const SOURCE_EXTENSIONS = [".mjs", ".js", ".ts"];

/**
 * Subcommands whose output is identifiers and counts.
 *
 * `fetch` transfers objects and prints refs and progress; it moves data onto the
 * runner rather than out of it. `rev-list` and `rev-parse` print SHAs. `cat-file`
 * prints whatever it is asked for, which is why it carries a required flag
 * below rather than sitting here unqualified.
 */
const SAFE_SUBCOMMANDS = new Set(["fetch", "rev-list", "rev-parse", "cat-file"]);

/**
 * Subcommands that exist to print what a commit says.
 *
 * Listed rather than left to "anything not safe" so the subcommand can be found
 * by membership instead of by position. Position does not survive the two forms
 * these calls are written in: `["-C", repo, "cat-file", …]` loses `repo` to a
 * variable when read statically, and the wrapper's `["-C", repo, ...args]` has
 * no literal subcommand in it at all.
 */
const TEXT_EMITTING_SUBCOMMANDS = new Set([
  "log",
  "show",
  "shortlog",
  "whatchanged",
  "blame",
  "describe",
  "grep",
  "diff",
  "diff-tree",
  "ls-tree",
  "ls-files",
  "for-each-ref",
  "notes",
  "tag",
  "annotate",
  "range-diff",
  "cherry",
  "format-patch",
  "bundle",
]);

const KNOWN_SUBCOMMANDS = new Set([
  ...SAFE_SUBCOMMANDS,
  ...TEXT_EMITTING_SUBCOMMANDS,
]);

/**
 * Flags that make a safe subcommand print the commit message.
 *
 * `--format` and `--pretty` are the direct route: `rev-list --format=%s` is the
 * whole leak in one flag. `--header` prints the raw commit object, message
 * included. `--oneline` and `--graph` are `log`'s idiom and imply a pretty
 * format wherever they are accepted. `-p` and a bare `--batch` are `cat-file`
 * printing object contents rather than describing them.
 */
const UNSAFE_FLAGS = [
  /^--format(=|$)/,
  /^--pretty(=|$)/,
  /^--header$/,
  /^--oneline$/,
  /^--graph$/,
  /^-p$/,
];

// `cat-file` may only ask what an object *is*. `--batch-check` prints
// "<sha> <type> <size>"; `--batch` prints the object, and on a commit the
// object is its message.
const CAT_FILE_REQUIRED_FLAG = "--batch-check";

const failures = [];

const fail = (where, message) => {
  failures.push(`${where}: ${message}`);
};

/**
 * The subcommand in an argument list, or `undefined` if there is none to find.
 *
 * By membership rather than by position. `-C <path>` sits ahead of the
 * subcommand and its path is often a variable that a static read cannot see, so
 * counting positions lands on the wrong token — the first version of this check
 * read `["-C", repo, "cat-file", "--batch-check"]` as a call with no subcommand
 * and reported the one safe call in the codebase as unreadable.
 *
 * `undefined` means this array is not a git invocation, which is the correct
 * reading of a wrapper's `["-C", repo, ...args]`: the subcommand is at the
 * wrapper's call sites, and those are checked in their own right.
 */
const findSubcommand = (args) =>
  args.find((arg) => KNOWN_SUBCOMMANDS.has(arg));

/**
 * Judge one git invocation, given its arguments with `git` already stripped.
 */
const checkInvocation = (where, args) => {
  const flags = args.filter((arg) => arg.startsWith("-"));
  const subcommand = findSubcommand(args);
  if (!subcommand) {
    return false;
  }
  if (!SAFE_SUBCOMMANDS.has(subcommand)) {
    fail(
      where,
      `\`git ${subcommand}\` can print commit messages. Allowed against the private clone: ${[...SAFE_SUBCOMMANDS].join(", ")}. ` +
        "If this is genuinely needed, the disclosure question comes before the code.",
    );
    return true;
  }
  for (const flag of flags) {
    if (UNSAFE_FLAGS.some((pattern) => pattern.test(flag))) {
      fail(
        where,
        `\`git ${subcommand} ${flag}\` prints commit text into a public log.`,
      );
    }
  }
  if (subcommand === "cat-file" && !flags.includes(CAT_FILE_REQUIRED_FLAG)) {
    fail(
      where,
      `\`git cat-file\` against the private clone must carry ${CAT_FILE_REQUIRED_FLAG}; ` +
        "without it the object itself is printed, and a commit object is its message.",
    );
  }
  return true;
};

// --- the workflow -------------------------------------------------------------

const workflow = parse(await readFile(WORKFLOW, "utf8"));

/**
 * Every git line in a `run:` block that targets the private clone.
 *
 * Two ways to target it: `git -C <path>` naming it, or a step whose
 * `working-directory` is the clone, where a bare `git` lands inside it.
 */
const gitLinesAgainstPrivateRepo = (script, workingDirectory) => {
  const inClone = PRIVATE_REPO_TOKENS.some((token) =>
    (workingDirectory ?? "").includes(token),
  );
  const lines = [];
  for (const raw of script.split("\n")) {
    const line = raw.trim();
    // `git` as its own word, so `github`, `gitignore` and a `git` inside a
    // comment about some other repository do not become findings.
    const match = line.match(/(?:^|[|&;(]\s*|\$\(\s*)git\s+(.+)$/);
    if (!match) {
      continue;
    }
    if (line.startsWith("#")) {
      continue;
    }
    const args = match[1];
    const namesClone = PRIVATE_REPO_TOKENS.some((token) =>
      args.includes(token),
    );
    // A bare `git` in a step working inside the clone, or a `-C` naming it.
    if (namesClone || (inClone && !args.includes("-C"))) {
      lines.push(args);
    }
  }
  return lines;
};

let workflowInvocations = 0;
for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
  for (const step of job.steps ?? []) {
    if (typeof step.run !== "string") {
      continue;
    }
    const workingDirectory = step["working-directory"] ?? job.defaults?.run?.["working-directory"];
    for (const args of gitLinesAgainstPrivateRepo(step.run, workingDirectory)) {
      const read = checkInvocation(
        `${WORKFLOW} · ${jobName} · ${step.name ?? step.id ?? "(unnamed step)"}`,
        // Continuation backslashes and quoting are shell, not arguments.
        args
          .replace(/\\$/, "")
          .split(/\s+/)
          .filter(Boolean)
          .map((token) => token.replace(/^["']|["']$/g, "")),
      );
      if (read) {
        workflowInvocations += 1;
        continue;
      }
      // A git line aimed at the private clone whose subcommand this check does
      // not recognise. Failing is the only safe reading: the alternative is
      // passing an unknown command because it was unknown.
      fail(
        `${WORKFLOW} · ${jobName} · ${step.name ?? step.id ?? "(unnamed step)"}`,
        `could not find a known subcommand in \`git ${args.trim()}\`. Add it to SAFE_SUBCOMMANDS or TEXT_EMITTING_SUBCOMMANDS after deciding which it is.`,
      );
    }
  }
}

// The three that exist today: `rev-parse HEAD` in the resolve job, and `fetch`
// plus `rev-list --count` in the ordering step. A count that drops means a call
// was removed or renamed past this scanner's reading, which is worth failing on
// — a guard that silently stops finding anything is the failure it exists to
// prevent.
if (workflowInvocations < 3) {
  fail(
    WORKFLOW,
    `expected at least 3 git invocations against the private clone, found ${workflowInvocations}. ` +
      "Either they were removed, or they are now written in a form this check cannot read.",
  );
}

// --- the scripts ---------------------------------------------------------------

const sourceFiles = [];
for (const directory of SOURCE_DIRECTORIES) {
  for (const entry of await readdir(directory, { recursive: true })) {
    if (SOURCE_EXTENSIONS.some((extension) => entry.endsWith(extension))) {
      sourceFiles.push(join(directory, entry));
    }
  }
}
// A scanner that finds no files passes everything. This is the count of source
// files it read, not of findings, and it drops to zero if a rename or a move
// puts the code somewhere this does not look.
if (sourceFiles.length <= 50) {
  fail(
    SOURCE_DIRECTORIES.join(", "),
    `expected to scan the source tree, found only ${sourceFiles.length} files. A scanner that finds nothing passes everything.`,
  );
}

/**
 * The file with its whole-line comments removed.
 *
 * Code, not prose: a file may discuss the private clone at length without
 * touching it. `run-shadow-analysis.mjs` explains why the clone is there, and
 * this check itself quotes the very calls it is looking for — read as text,
 * both look exactly like the thing being guarded against.
 *
 * Whole lines only. Cutting at the first `//` inside a line would also cut a
 * URL in a string, and anything after it on that line — including a real git
 * call — would stop being scanned. A guard's parsing errors must not fall on
 * the side of seeing less.
 */
const withoutComments = (source) =>
  source
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !trimmed.startsWith("//") &&
        !trimmed.startsWith("*") &&
        !trimmed.startsWith("/*")
      );
    })
    .join("\n");

let scannedForPrivateRepo = 0;
for (const path of sourceFiles) {
  const source = withoutComments(await readFile(path, "utf8"));
  const namesPrivateRepo = PRIVATE_REPO_TOKENS.some((token) =>
    source.includes(token),
  );
  const spawnsGit = /["'`]git["'`]/.test(source);
  if (!namesPrivateRepo || !spawnsGit) {
    continue;
  }
  if (!ALLOWED_SCRIPTS.has(path)) {
    fail(
      path,
      "this file both names the private clone and spawns git. Add it to ALLOWED_SCRIPTS only " +
        "after deciding what its git calls can print into a public log.",
    );
    continue;
  }
  scannedForPrivateRepo += 1;
  // Argument arrays as this codebase writes them: `run("git", ["-C", repo, …])`.
  // Non-literal entries are variables — the repository path, a branch name —
  // and are dropped rather than guessed at; the subcommand and its flags are
  // always literals.
  //
  // Every array literal is read, not only the ones written next to `"git"`.
  // These files pass argument lists through a local `git(repo, [...])` wrapper,
  // so the array that names the subcommand and the string `"git"` are in
  // different expressions.
  const arrays = [...source.matchAll(/\[([^[\]]*)\]/g)];
  let readInvocations = 0;
  for (const [, body] of arrays) {
    const args = [...body.matchAll(/["']([^"']+)["']/g)].map(
      (match) => match[1],
    );
    if (checkInvocation(path, args)) {
      readInvocations += 1;
    }
  }
  if (readInvocations === 0) {
    fail(
      path,
      "spawns git against the private clone, but no subcommand in it could be read. It has to be readable to be checked.",
    );
  }
}

if (failures.length > 0) {
  console.error(
    `Private repository git reads: ${failures.length} problem${failures.length === 1 ? "" : "s"}.\n` +
      failures.map((line) => `  - ${line}`).join("\n"),
  );
  process.exit(1);
}

// Every allowed script must still be one that touches the private clone. A name
// left behind after a refactor is a standing permission for a file that no
// longer needs it, and the next file to take that path inherits it silently.
if (scannedForPrivateRepo !== ALLOWED_SCRIPTS.size) {
  fail(
    "ALLOWED_SCRIPTS",
    `lists ${ALLOWED_SCRIPTS.size} file(s), but ${scannedForPrivateRepo} of them still run git against the private clone. ` +
      "Remove the ones that no longer do — a leftover name is a standing permission.",
  );
}

console.log(
  `Private repository git reads ok (${sourceFiles.length} source files scanned, ` +
    `${workflowInvocations} workflow invocations, ${scannedForPrivateRepo} allowed script).`,
);
