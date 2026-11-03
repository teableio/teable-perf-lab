#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, lstat, realpath, rm, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const SCHEMA = 2;
const MANIFEST_NAME = ".bench-runtime-manifest.json";
const DEFAULT_FILTER = "@teable/v2-headless-bench...";
const SHA_PATTERN = /^[0-9a-f]{40}$/;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = result.stderr?.trim();
    throw new Error(
      `${command} exited ${result.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return result.stdout;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function normalizeRelativePath(path) {
  const normalized = path
    .replaceAll("\\", "/")
    .replace(/^\.\//, "")
    .replace(/\/$/, "");
  if (
    normalized.length === 0 ||
    normalized.includes("\0") ||
    normalized.includes("\n") ||
    normalized.includes("\r") ||
    normalized.startsWith("/") ||
    normalized
      .split("/")
      .some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe archive path: ${JSON.stringify(path)}`);
  }
  return normalized;
}

function isRuntimeRoot(path) {
  return (
    path === "node_modules" ||
    path.endsWith("/node_modules") ||
    path.endsWith("/dist")
  );
}

function validateRuntimeRoot(path) {
  const normalized = normalizeRelativePath(path);
  if (!isRuntimeRoot(normalized)) {
    throw new Error(
      `Runtime archive path must be node_modules or dist: ${normalized}`,
    );
  }
  return normalized;
}

function assertInsideRoot(rootDir, candidate, label) {
  const rel = relative(rootDir, candidate);
  if (
    rel === "" ||
    isAbsolute(rel) ||
    rel === ".." ||
    rel.startsWith(`..${sep}`)
  ) {
    throw new Error(`${label} is outside the repository: ${candidate}`);
  }
  return normalizeRelativePath(rel);
}

export function runtimeIdentity({ pnpmVersion } = {}) {
  if (!pnpmVersion) throw new Error("pnpmVersion is required");
  return {
    node: process.version,
    nodeAbi: process.versions.modules,
    platform: process.platform,
    arch: process.arch,
    pnpm: pnpmVersion,
  };
}

export async function discoverWorkspacePackageDirs({
  rootDir,
  filter = DEFAULT_FILTER,
  runCommand = run,
}) {
  const root = resolve(rootDir);
  const stdout = runCommand(
    "pnpm",
    ["--filter", filter, "list", "--depth", "-1", "--json"],
    { cwd: root },
  );
  let packages;
  try {
    packages = JSON.parse(stdout);
  } catch {
    throw new Error(
      "pnpm returned invalid JSON while resolving the benchmark dependency closure",
    );
  }
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error(`pnpm filter ${filter} selected no workspace packages`);
  }

  const dirs = [];
  for (const entry of packages) {
    if (typeof entry?.path !== "string")
      throw new Error("pnpm package entry is missing path");
    const packageDir = await realpath(resolve(entry.path));
    dirs.push(assertInsideRoot(root, packageDir, "Workspace package"));
  }
  return [...new Set(dirs)].sort();
}

export async function collectRuntimePaths({ rootDir, workspacePackageDirs }) {
  const root = resolve(rootDir);
  const paths = [];
  if (!(await exists(resolve(root, "node_modules")))) {
    throw new Error("Filtered install did not create root node_modules");
  }
  paths.push("node_modules");

  for (const packageDir of workspacePackageDirs) {
    const safePackageDir = normalizeRelativePath(packageDir);
    for (const leaf of ["node_modules", "dist"]) {
      const rel = `${safePackageDir}/${leaf}`;
      if (await exists(resolve(root, rel)))
        paths.push(validateRuntimeRoot(rel));
    }
  }

  if (!paths.some((path) => path.endsWith("/dist"))) {
    throw new Error("Filtered build produced no workspace dist directory");
  }
  return [...new Set(paths)].sort();
}

function validateCheckoutSha(checkoutSha) {
  const normalized = checkoutSha?.toLowerCase();
  if (!SHA_PATTERN.test(normalized ?? "")) {
    throw new Error("checkoutSha must be an exact 40-character Git commit SHA");
  }
  return normalized;
}

function validateHarnessSha(harnessSha) {
  const normalized = harnessSha?.toLowerCase();
  if (!SHA_PATTERN.test(normalized ?? "")) {
    throw new Error("harnessSha must be an exact 40-character Git commit SHA");
  }
  return normalized;
}

function validateManifest(value) {
  if (!value || value.schema !== SCHEMA)
    throw new Error("Unsupported runtime archive manifest");
  const checkoutSha = validateCheckoutSha(value.checkoutSha);
  const harnessSha = validateHarnessSha(value.harnessSha);
  if (!value.runtime || typeof value.runtime !== "object") {
    throw new Error("Runtime archive manifest is missing runtime identity");
  }
  for (const key of ["node", "nodeAbi", "platform", "arch", "pnpm"]) {
    if (
      typeof value.runtime[key] !== "string" ||
      value.runtime[key].length === 0
    ) {
      throw new Error(`Runtime archive manifest is missing runtime.${key}`);
    }
  }
  if (!Array.isArray(value.paths) || value.paths.length === 0) {
    throw new Error("Runtime archive manifest has no paths");
  }
  const paths = value.paths.map(validateRuntimeRoot);
  if (new Set(paths).size !== paths.length) {
    throw new Error("Runtime archive manifest contains duplicate paths");
  }
  return {
    schema: SCHEMA,
    checkoutSha,
    harnessSha,
    runtime: value.runtime,
    paths,
  };
}

function compareRuntime(expected, actual) {
  for (const key of ["node", "nodeAbi", "platform", "arch", "pnpm"]) {
    if (expected[key] !== actual[key]) {
      throw new Error(
        `Runtime mismatch for ${key}: archive=${expected[key]} current=${actual[key]}`,
      );
    }
  }
}

export function validateArchiveMembers(members, paths) {
  const roots = paths.map(validateRuntimeRoot);
  let sawManifest = false;
  for (const rawMember of members) {
    if (rawMember.length === 0) continue;
    const member = normalizeRelativePath(rawMember);
    if (member === MANIFEST_NAME) {
      sawManifest = true;
      continue;
    }
    if (
      !roots.some((root) => member === root || member.startsWith(`${root}/`))
    ) {
      throw new Error(
        `Archive member is outside declared runtime paths: ${member}`,
      );
    }
  }
  if (!sawManifest) throw new Error("Runtime archive has no manifest member");
}

function listArchiveMembers(archivePath, runCommand = run) {
  return runCommand("tar", ["--zstd", "-tf", archivePath]).split("\n");
}

function readArchiveManifest(archivePath, runCommand = run) {
  const source = runCommand("tar", [
    "--zstd",
    "-xOf",
    archivePath,
    MANIFEST_NAME,
  ]);
  try {
    return validateManifest(JSON.parse(source));
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error("Runtime archive manifest is invalid JSON");
    throw error;
  }
}

export async function createRuntimeArchive({
  rootDir,
  archivePath,
  checkoutSha,
  harnessSha,
  runtime,
  workspacePackageDirs,
  filter = DEFAULT_FILTER,
  runCommand = run,
}) {
  const root = resolve(rootDir);
  const archive = resolve(archivePath);
  if (await exists(archive))
    throw new Error(`Refusing to overwrite archive: ${archive}`);
  if (await exists(resolve(root, MANIFEST_NAME))) {
    throw new Error(`Refusing to overwrite repository file: ${MANIFEST_NAME}`);
  }

  const packageDirs =
    workspacePackageDirs ??
    (await discoverWorkspacePackageDirs({ rootDir: root, filter, runCommand }));
  const paths = await collectRuntimePaths({
    rootDir: root,
    workspacePackageDirs: packageDirs,
  });
  const manifest = validateManifest({
    schema: SCHEMA,
    checkoutSha,
    harnessSha,
    runtime,
    paths,
  });
  const manifestPath = resolve(root, MANIFEST_NAME);
  const listPath = `${archive}.files`;

  try {
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, {
      flag: "wx",
    });
    await writeFile(listPath, `${[MANIFEST_NAME, ...paths].join("\0")}\0`, {
      flag: "wx",
    });
    runCommand(
      "tar",
      [
        "--zstd",
        "-cf",
        archive,
        "-C",
        root,
        "--null",
        "--verbatim-files-from",
        "-T",
        listPath,
      ],
      { cwd: root },
    );
  } finally {
    await rm(manifestPath, { force: true });
    await rm(listPath, { force: true });
  }

  return manifest;
}

export async function restoreRuntimeArchive({
  rootDir,
  archivePath,
  checkoutSha,
  expectedHarnessSha,
  runtime,
  runCommand = run,
}) {
  const root = resolve(rootDir);
  const archive = resolve(archivePath);
  const manifest = readArchiveManifest(archive, runCommand);
  const expectedSha = validateCheckoutSha(checkoutSha);
  if (manifest.checkoutSha !== expectedSha) {
    throw new Error(
      `Checkout SHA mismatch: archive=${manifest.checkoutSha} current=${expectedSha}`,
    );
  }
  const expectedHarness = validateHarnessSha(expectedHarnessSha);
  if (manifest.harnessSha !== expectedHarness) {
    throw new Error(
      `Harness SHA mismatch: archive=${manifest.harnessSha} current=${expectedHarness}`,
    );
  }
  compareRuntime(manifest.runtime, runtime);
  validateArchiveMembers(
    listArchiveMembers(archive, runCommand),
    manifest.paths,
  );

  for (const path of [MANIFEST_NAME, ...manifest.paths]) {
    if (await exists(resolve(root, path))) {
      throw new Error(`Refusing to overwrite existing runtime path: ${path}`);
    }
  }

  runCommand(
    "tar",
    [
      "--zstd",
      "-xf",
      archive,
      "-C",
      root,
      "--no-same-owner",
      "--no-same-permissions",
    ],
    { cwd: root },
  );
  await rm(resolve(root, MANIFEST_NAME), { force: true });
  for (const path of manifest.paths) {
    await lstat(resolve(root, path));
  }
  return manifest;
}

function usage() {
  return `Usage:
  bench-runtime-archive.mjs create --root <repo> --archive <tar.zst> --sha <source-commit> --harness-sha <harness-commit> [--filter <pnpm-filter>]
  bench-runtime-archive.mjs restore --root <repo> --archive <tar.zst> --sha <source-commit> --harness-sha <harness-commit>`;
}

async function pnpmRuntime() {
  return runtimeIdentity({ pnpmVersion: run("pnpm", ["--version"]).trim() });
}

async function main(argv) {
  const command = argv[0];
  if (command !== "create" && command !== "restore") throw new Error(usage());
  const { values, positionals } = parseArgs({
    args: argv.slice(1),
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      archive: { type: "string" },
      sha: { type: "string" },
      "harness-sha": { type: "string" },
      filter: { type: "string", default: DEFAULT_FILTER },
    },
  });
  if (
    positionals.length > 0 ||
    !values.root ||
    !values.archive ||
    !values.sha ||
    !values["harness-sha"]
  ) {
    throw new Error(usage());
  }
  const options = {
    rootDir: values.root,
    archivePath: values.archive,
    checkoutSha: values.sha,
    runtime: await pnpmRuntime(),
  };
  if (command === "create") {
    await createRuntimeArchive({
      ...options,
      harnessSha: values["harness-sha"],
      filter: values.filter,
    });
  } else {
    await restoreRuntimeArchive({
      ...options,
      expectedHarnessSha: values["harness-sha"],
    });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
