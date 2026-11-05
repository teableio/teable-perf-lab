#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import YAML from "yaml";

const SHA = /^[0-9a-f]{40}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const git = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const exists = async (path) =>
  lstat(path).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );

export function mergeDependencyOverlay(lock, fragment) {
  if (String(lock.lockfileVersion) !== "9.0")
    throw new Error("Unsupported tested lockfile version");
  const result = structuredClone(lock);
  if (result.importers[fragment.key])
    throw new Error("Benchmark package is already in the source lock");
  result.importers[fragment.key] = fragment.value;
  for (const section of ["packages", "snapshots"]) {
    result[section] ??= {};
    for (const [key, value] of Object.entries(fragment[section])) {
      // The tested source owns existing package resolutions. Only missing entries are added.
      if (!Object.hasOwn(result[section], key)) result[section][key] = value;
    }
  }
  return result;
}

/** Mount lab-owned files into a disposable checkout; never copy product code into the lab. */
export async function prepareWorkspace({
  sourceRoot,
  sourceSha,
  harnessSha,
  sourceRepository = "teableio/teable-ee",
  labRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."),
}) {
  for (const [name, sha] of Object.entries({ sourceSha, harnessSha })) {
    if (!SHA.test(sha ?? ""))
      throw new Error(`${name} must be an exact 40-character SHA`);
  }
  const root = resolve(sourceRoot);
  const lab = resolve(labRoot);
  if (git(root, ["rev-parse", "HEAD"]) !== sourceSha)
    throw new Error("Tested source SHA mismatch");
  if (git(lab, ["rev-parse", "HEAD"]) !== harnessSha)
    throw new Error("Benchmark harness SHA mismatch");
  if (git(root, ["diff", "HEAD", "--name-only"]))
    throw new Error("Tested source has tracked changes");
  if (git(lab, ["diff", "HEAD", "--name-only", "--", "headless"]))
    throw new Error("Benchmark harness has tracked changes");
  const ee = await exists(
    join(root, "community/packages/v2/core/package.json"),
  );
  const prefix = ee
    ? "community/packages/v2/headless-bench"
    : "packages/v2/headless-bench";
  const corePath = ee
    ? "community/packages/v2/core/package.json"
    : "packages/v2/core/package.json";
  if (!(await exists(join(root, corePath))))
    throw new Error("Source is not a Teable v2 workspace");
  const target = join(root, prefix);
  if (await exists(target))
    throw new Error("Refusing to overwrite an existing benchmark package");
  const overlay = JSON.parse(
    await readFile(join(lab, "headless/workspace-lock.json"), "utf8"),
  );
  if (overlay.version !== 1)
    throw new Error("Unsupported benchmark dependency overlay");
  const provenance = {
    schema: 1,
    source: { repository: sourceRepository, sha: sourceSha },
    harness: { repository: "teableio/teable-perf-lab", sha: harnessSha },
    lockfiles: {},
  };
  const pending = [];
  const lockInputs = ee
    ? Object.entries(overlay.importers)
    : [["pnpm-lock.yaml", overlay.importers["community/pnpm-lock.yaml"]]];
  for (const [lockPath, input] of lockInputs) {
    if (!input)
      throw new Error(`Benchmark dependency overlay is missing ${lockPath}`);
    const original = await readFile(join(root, lockPath), "utf8");
    const fragment = {
      ...input,
      packages: overlay.packages,
      snapshots: overlay.snapshots,
    };
    const merged = mergeDependencyOverlay(YAML.parse(original), fragment);
    const bytes = YAML.stringify(merged, { lineWidth: 0 });
    pending.push([lockPath, bytes]);
    provenance.lockfiles[lockPath] = {
      sourceSha256: digest(original),
      preparedSha256: digest(bytes),
    };
  }
  const tracked = git(lab, ["ls-files", "-z", "--", "headless/package"])
    .split("\0")
    .filter(Boolean);
  if (!tracked.includes("headless/package/package.json"))
    throw new Error("Benchmark package is not committed in lab");
  for (const path of tracked) {
    const source = join(lab, path);
    const stat = await lstat(source);
    if (!stat.isFile())
      throw new Error(`Benchmark source must be a regular file: ${path}`);
    const destination = join(target, path.slice("headless/package/".length));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source, destination);
  }
  for (const [path, bytes] of pending) await writeFile(join(root, path), bytes);
  await writeFile(
    join(root, ".headless-bench-source.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const { values } = parseArgs({
    options: {
      "source-root": { type: "string" },
      "source-sha": { type: "string" },
      "harness-sha": { type: "string" },
      "source-repository": { type: "string" },
    },
  });
  if (!values["source-root"]) throw new Error("--source-root is required");
  console.log(
    JSON.stringify(
      await prepareWorkspace({
        sourceRoot: values["source-root"],
        sourceSha: values["source-sha"],
        harnessSha: values["harness-sha"],
        sourceRepository: values["source-repository"],
      }),
    ),
  );
}
