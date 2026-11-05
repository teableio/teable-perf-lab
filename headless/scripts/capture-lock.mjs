#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";

const { values } = parseArgs({
  options: { "source-root": { type: "string" } },
});
if (!values["source-root"]) throw new Error("--source-root is required");
const root = resolve(values["source-root"]);
const overlay = { version: 1, importers: {}, packages: {}, snapshots: {} };
for (const [path, key] of [
  ["pnpm-lock.yaml", "community/packages/v2/headless-bench"],
  ["community/pnpm-lock.yaml", "packages/v2/headless-bench"],
]) {
  const lock = YAML.parse(await readFile(resolve(root, path), "utf8"));
  const importer = lock.importers[key];
  if (!importer) throw new Error(`Missing benchmark importer in ${path}`);
  overlay.importers[path] = { key, value: importer };
  const visited = new Set();
  const visit = (name, version) => {
    if (version.startsWith("link:")) return;
    const key = lock.snapshots[`${name}@${version}`]
      ? `${name}@${version}`
      : version;
    if (visited.has(key)) return;
    visited.add(key);
    const snapshot = lock.snapshots[key];
    if (!snapshot) throw new Error(`Missing dependency snapshot: ${key}`);
    const packageKey = key.split("(")[0];
    const metadata = lock.packages[packageKey];
    if (!metadata)
      throw new Error(`Missing dependency integrity: ${packageKey}`);
    overlay.packages[packageKey] = metadata;
    overlay.snapshots[key] = snapshot;
    for (const section of ["dependencies", "optionalDependencies"]) {
      for (const [dependency, resolved] of Object.entries(
        snapshot[section] ?? {},
      )) {
        visit(dependency, resolved);
      }
    }
  };
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
  ]) {
    for (const [name, { version }] of Object.entries(importer[section] ?? {}))
      visit(name, version);
  }
}
for (const key of ["packages", "snapshots"]) {
  overlay[key] = Object.fromEntries(
    Object.entries(overlay[key]).sort(([a], [b]) => a.localeCompare(b)),
  );
}
await writeFile(
  new URL("../workspace-lock.json", import.meta.url),
  `${JSON.stringify(overlay, null, 2)}\n`,
);
const source = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
console.log(
  JSON.stringify({
    source,
    packages: Object.keys(overlay.packages).length,
    snapshots: Object.keys(overlay.snapshots).length,
  }),
);
