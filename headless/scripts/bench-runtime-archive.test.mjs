import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createRuntimeArchive,
  restoreRuntimeArchive,
} from "./bench-runtime-archive.mjs";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const HARNESS_SHA = "c".repeat(40);
const OTHER_HARNESS_SHA = "d".repeat(40);
const RUNTIME = {
  node: "v24.19.0",
  nodeAbi: "137",
  platform: "linux",
  arch: "x64",
  pnpm: "12.11.2",
};

function command(name, args, options = {}) {
  const result = spawnSync(name, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  return result.stdout;
}

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "bench-runtime-"));
  const root = join(temp, "repo");
  const archive = join(temp, "runtime.tar.zst");
  await mkdir(join(root, "node_modules", ".pnpm", "dependency"), {
    recursive: true,
  });
  await writeFile(
    join(root, "node_modules", ".pnpm", "dependency", "index.js"),
    Buffer.from([0, 1, 2, 3, 255]),
  );
  await mkdir(join(root, "packages", "bench", "node_modules"), {
    recursive: true,
  });
  await symlink(
    "../../../node_modules/.pnpm/dependency",
    join(root, "packages", "bench", "node_modules", "dependency"),
    "dir",
  );
  await mkdir(join(root, "packages", "bench", "dist"), { recursive: true });
  await writeFile(
    join(root, "packages", "bench", "dist", "run.js"),
    "export const ready = true;\n",
  );
  await mkdir(join(root, "packages", "unrelated", "dist"), { recursive: true });
  await writeFile(
    join(root, "packages", "unrelated", "dist", "secret.js"),
    "not closure\n",
  );
  return { temp, root, archive };
}

async function packFixture(f) {
  return createRuntimeArchive({
    rootDir: f.root,
    archivePath: f.archive,
    checkoutSha: SHA,
    harnessSha: HARNESS_SHA,
    runtime: RUNTIME,
    workspacePackageDirs: ["packages/bench"],
  });
}

async function removePackedPaths(root) {
  await rm(join(root, "node_modules"), { recursive: true, force: true });
  await rm(join(root, "packages", "bench", "node_modules"), {
    recursive: true,
    force: true,
  });
  await rm(join(root, "packages", "bench", "dist"), {
    recursive: true,
    force: true,
  });
}

test("packages and restores the installed closure with dist files and pnpm symlinks", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temp, { recursive: true, force: true }));

  const manifest = await packFixture(f);
  assert.equal(manifest.schema, 2);
  assert.equal(manifest.checkoutSha, SHA);
  assert.equal(manifest.harnessSha, HARNESS_SHA);
  assert.deepEqual(manifest.paths, [
    "node_modules",
    "packages/bench/dist",
    "packages/bench/node_modules",
  ]);
  await removePackedPaths(f.root);

  await restoreRuntimeArchive({
    rootDir: f.root,
    archivePath: f.archive,
    checkoutSha: SHA,
    expectedHarnessSha: HARNESS_SHA,
    runtime: RUNTIME,
  });

  assert.deepEqual(
    await readFile(
      join(f.root, "node_modules", ".pnpm", "dependency", "index.js"),
    ),
    Buffer.from([0, 1, 2, 3, 255]),
  );
  assert.equal(
    await readlink(
      join(f.root, "packages", "bench", "node_modules", "dependency"),
    ),
    "../../../node_modules/.pnpm/dependency",
  );
  assert.equal(
    await readFile(join(f.root, "packages", "bench", "dist", "run.js"), "utf8"),
    "export const ready = true;\n",
  );
  assert.equal(
    await readFile(
      join(f.root, "packages", "unrelated", "dist", "secret.js"),
      "utf8",
    ),
    "not closure\n",
  );
  await assert.rejects(
    readFile(join(f.root, ".bench-runtime-manifest.json")),
    /ENOENT/,
  );
});

test("rejects a stale checkout SHA before extracting the runtime", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temp, { recursive: true, force: true }));
  await packFixture(f);
  await removePackedPaths(f.root);

  await assert.rejects(
    restoreRuntimeArchive({
      rootDir: f.root,
      archivePath: f.archive,
      checkoutSha: OTHER_SHA,
      expectedHarnessSha: HARNESS_SHA,
      runtime: RUNTIME,
    }),
    /Checkout SHA mismatch/,
  );
  await assert.rejects(
    readFile(join(f.root, "node_modules", ".pnpm", "dependency", "index.js")),
    /ENOENT/,
  );
});

test("rejects a stale harness SHA before extracting the runtime", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temp, { recursive: true, force: true }));
  await packFixture(f);
  await removePackedPaths(f.root);

  await assert.rejects(
    restoreRuntimeArchive({
      rootDir: f.root,
      archivePath: f.archive,
      checkoutSha: SHA,
      expectedHarnessSha: OTHER_HARNESS_SHA,
      runtime: RUNTIME,
    }),
    /Harness SHA mismatch/,
  );
  await assert.rejects(
    readFile(join(f.root, "packages", "bench", "dist", "run.js")),
    /ENOENT/,
  );
});

test("rejects a stale Node runtime before extracting the runtime", async (t) => {
  const f = await fixture();
  t.after(() => rm(f.temp, { recursive: true, force: true }));
  await packFixture(f);
  await removePackedPaths(f.root);

  await assert.rejects(
    restoreRuntimeArchive({
      rootDir: f.root,
      archivePath: f.archive,
      checkoutSha: SHA,
      expectedHarnessSha: HARNESS_SHA,
      runtime: { ...RUNTIME, node: "v24.20.0" },
    }),
    /Runtime mismatch for node/,
  );
  await assert.rejects(
    readFile(join(f.root, "packages", "bench", "dist", "run.js")),
    /ENOENT/,
  );
});

test("rejects a schema-1 archive before extracting the runtime", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "bench-runtime-schema-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  const source = join(temp, "source");
  const archive = join(temp, "legacy.tar.zst");
  await mkdir(join(source, "node_modules"), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    join(source, ".bench-runtime-manifest.json"),
    `${JSON.stringify({ schema: 1, checkoutSha: SHA, runtime: RUNTIME, paths: ["node_modules"] })}\n`,
  );
  await writeFile(join(source, "node_modules", "legacy.js"), "legacy\n");
  command("tar", [
    "--zstd",
    "-cf",
    archive,
    "-C",
    source,
    ".bench-runtime-manifest.json",
    "node_modules",
  ]);

  await assert.rejects(
    restoreRuntimeArchive({
      rootDir: root,
      archivePath: archive,
      checkoutSha: SHA,
      expectedHarnessSha: HARNESS_SHA,
      runtime: RUNTIME,
    }),
    /Unsupported runtime archive manifest/,
  );
  await assert.rejects(
    readFile(join(root, "node_modules", "legacy.js")),
    /ENOENT/,
  );
});

test("rejects an archive path traversal before extraction", async (t) => {
  const temp = await mkdtemp(join(tmpdir(), "bench-runtime-traversal-"));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const root = join(temp, "repo");
  const source = join(temp, "source");
  const maliciousTar = join(temp, "malicious.tar");
  const archive = join(temp, "malicious.tar.zst");
  await mkdir(join(source, "node_modules"), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(
    join(source, ".bench-runtime-manifest.json"),
    `${JSON.stringify({
      schema: 2,
      checkoutSha: SHA,
      harnessSha: HARNESS_SHA,
      runtime: RUNTIME,
      paths: ["node_modules"],
    })}\n`,
  );
  await writeFile(join(source, "node_modules", "safe.js"), "safe\n");
  await writeFile(join(source, "escape.js"), "escape\n");

  command("tar", [
    "-cf",
    maliciousTar,
    "-C",
    source,
    ".bench-runtime-manifest.json",
    "node_modules",
  ]);
  command("tar", [
    "-rf",
    maliciousTar,
    "-C",
    source,
    "--transform=s|escape.js|../escaped.js|",
    "escape.js",
  ]);
  command("zstd", ["-q", maliciousTar, "-o", archive]);

  await assert.rejects(
    restoreRuntimeArchive({
      rootDir: root,
      archivePath: archive,
      checkoutSha: SHA,
      expectedHarnessSha: HARNESS_SHA,
      runtime: RUNTIME,
    }),
    /Unsafe archive path|outside declared runtime paths/,
  );
  await assert.rejects(readFile(join(temp, "escaped.js")), /ENOENT/);
  await assert.rejects(
    readFile(join(root, "node_modules", "safe.js")),
    /ENOENT/,
  );
});
