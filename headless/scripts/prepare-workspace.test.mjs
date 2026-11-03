import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import {
  mergeDependencyOverlay,
  prepareWorkspace,
} from "./prepare-workspace.mjs";

const command = (cwd, args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const save = async (root, path, data) => {
  const absolute = join(root, path);
  await mkdir(absolute.slice(0, absolute.lastIndexOf("/")), {
    recursive: true,
  });
  await writeFile(absolute, data);
};
const commit = (root) => {
  command(root, ["init"]);
  command(root, ["add", "."]);
  command(root, [
    "-c",
    "user.name=fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-m",
    "fixture",
  ]);
  return command(root, ["rev-parse", "HEAD"]);
};
const sourceLock = {
  lockfileVersion: "9.0",
  importers: { ".": {} },
  packages: { "shared@1": { resolution: { integrity: "source-integrity" } } },
  snapshots: { "shared@1": {} },
};
const fragment = {
  key: "community/packages/v2/headless-bench",
  value: { dependencies: { added: { specifier: "1", version: "1" } } },
  packages: {
    "added@1": { resolution: { integrity: "added-integrity" } },
    "shared@1": { resolution: { integrity: "different-integrity" } },
  },
  snapshots: { "added@1": {}, "shared@1": { dependencies: { added: "1" } } },
};

test("overlay adds benchmark dependencies without replacing tested-source resolutions", () => {
  const result = mergeDependencyOverlay(sourceLock, fragment);
  assert.equal(
    result.packages["shared@1"].resolution.integrity,
    "source-integrity",
  );
  assert.deepEqual(result.snapshots["shared@1"], {});
  assert.equal(
    result.packages["added@1"].resolution.integrity,
    "added-integrity",
  );
  assert.deepEqual(sourceLock.importers, { ".": {} });
  assert.throws(
    () => mergeDependencyOverlay(result, fragment),
    /already in the source lock/,
  );
});

for (const community of [false, true]) {
  test(`mounts committed harness into ${community ? "community" : "EE"} at independently pinned source revision`, async () => {
    const root = await mkdtemp(join(tmpdir(), "headless-overlay-"));
    try {
      const source = join(root, "source");
      const lab = join(root, "lab");
      await save(
        source,
        `${community ? "" : "community/"}packages/v2/core/package.json`,
        '{"name":"@teable/v2-core"}',
      );
      await save(source, "pnpm-lock.yaml", YAML.stringify(sourceLock));
      if (!community)
        await save(
          source,
          "community/pnpm-lock.yaml",
          YAML.stringify(sourceLock),
        );
      const sourceSha = commit(source);
      await save(
        lab,
        "headless/package/package.json",
        '{"name":"@teable/v2-headless-bench"}',
      );
      await save(
        lab,
        "headless/package/fixtures/test.tea",
        "synthetic-archive",
      );
      await save(
        lab,
        "headless/workspace-lock.json",
        JSON.stringify({
          version: 1,
          importers: {
            "pnpm-lock.yaml": fragment,
            "community/pnpm-lock.yaml": {
              ...fragment,
              key: "packages/v2/headless-bench",
            },
          },
          packages: fragment.packages,
          snapshots: fragment.snapshots,
        }),
      );
      const harnessSha = commit(lab);
      await assert.rejects(
        prepareWorkspace({
          sourceRoot: source,
          labRoot: lab,
          sourceSha: "a".repeat(40),
          harnessSha,
        }),
        /source SHA mismatch/,
      );
      await assert.rejects(
        prepareWorkspace({
          sourceRoot: source,
          labRoot: lab,
          sourceSha,
          harnessSha: "b".repeat(40),
        }),
        /harness SHA mismatch/,
      );
      const receipt = await prepareWorkspace({
        sourceRoot: source,
        labRoot: lab,
        sourceSha,
        harnessSha,
      });
      assert.equal(receipt.source.sha, sourceSha);
      assert.equal(receipt.harness.sha, harnessSha);
      assert.equal(command(source, ["rev-parse", "HEAD"]), sourceSha);
      assert.equal(
        await readFile(
          join(
            source,
            `${community ? "" : "community/"}packages/v2/headless-bench/fixtures/test.tea`,
          ),
          "utf8",
        ),
        "synthetic-archive",
      );
      assert.deepEqual(
        JSON.parse(
          await readFile(
            join(
              source,
              `${community ? "" : "community/"}packages/v2/core/package.json`,
            ),
            "utf8",
          ),
        ),
        { name: "@teable/v2-core" },
      );
      assert.ok(
        YAML.parse(await readFile(join(source, "pnpm-lock.yaml"), "utf8"))
          .importers[
          `${community ? "" : "community/"}packages/v2/headless-bench`
        ],
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("refuses dirty tested source before touching its package or lockfile", async () => {
  const root = await mkdtemp(join(tmpdir(), "headless-overlay-dirty-"));
  try {
    const source = join(root, "source");
    const lab = join(root, "lab");
    await save(source, "core.ts", "original");
    await save(lab, "harness.ts", "original");
    const sourceSha = commit(source);
    const harnessSha = commit(lab);
    await save(source, "core.ts", "modified");
    await assert.rejects(
      prepareWorkspace({
        sourceRoot: source,
        labRoot: lab,
        sourceSha,
        harnessSha,
      }),
      /tracked changes/,
    );
    assert.equal(await readFile(join(source, "core.ts"), "utf8"), "modified");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
