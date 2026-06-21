// G4 case-catalog guardrail.
//
// Fails `pnpm check` when the three views of the case catalog (case files on
// disk, registry imports, the registered `cases` array) disagree — including the
// import-not-in-array drift that used to pass silently. Before checking the real
// repo it self-tests the detector against synthetic catalogs, so a regression in
// the detector itself (which would make the guard silently useless) also fails.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listCatalogIssues, listCatalogIssuesForViews } from "./case-catalog.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

// Negative path: each broken catalog must produce its issue type. If any of
// these stops firing, the guard is no longer protecting that case.
const selfTest = () => {
  const healthy = {
    diskPaths: ["cases/a/x.case.ts", "cases/b/y.case.ts"],
    imports: [
      { name: "xCase", path: "cases/a/x.case.ts" },
      { name: "yCase", path: "cases/b/y.case.ts" },
    ],
    arrayEntries: ["xCase", "yCase"],
  };

  const expectFires = (label, mutate, expectedType) => {
    const views = structuredClone(healthy);
    mutate(views);
    const types = listCatalogIssuesForViews(views).map((i) => i.type);
    if (!types.includes(expectedType)) {
      throw new Error(
        `case-catalog self-test failed: "${label}" should produce "${expectedType}" but got [${types.join(", ")}]`,
      );
    }
  };

  if (listCatalogIssuesForViews(healthy).length !== 0) {
    throw new Error(
      "case-catalog self-test failed: a healthy catalog reported issues",
    );
  }
  expectFires(
    "disk file not imported",
    (v) => v.diskPaths.push("cases/c/z.case.ts"),
    "disk-not-imported",
  );
  expectFires(
    "import with no disk file",
    (v) => v.imports.push({ name: "zCase", path: "cases/c/z.case.ts" }),
    "import-not-on-disk",
  );
  expectFires(
    "imported but not in cases array",
    (v) => {
      v.imports.push({ name: "zCase", path: "cases/b/y.case.ts" });
      v.diskPaths = ["cases/a/x.case.ts", "cases/b/y.case.ts"];
    },
    "import-not-in-array",
  );
  expectFires(
    "cases array entry with no import",
    (v) => v.arrayEntries.push("ghostCase"),
    "array-entry-no-import",
  );
  expectFires(
    "duplicate cases array entry",
    (v) => v.arrayEntries.push("xCase"),
    "array-duplicate",
  );
};

const main = async () => {
  selfTest();

  const issues = await listCatalogIssues(repoRoot);
  if (issues.length > 0) {
    console.error("Perf case catalog is inconsistent:");
    for (const issue of issues) {
      console.error(`  - [${issue.type}] ${issue.message}`);
    }
    console.error(
      `\n${issues.length} catalog issue(s). Fix registry.ts / cases / markdown so disk, imports, and the cases array agree.`,
    );
    process.exitCode = 1;
    return;
  }

  console.log("Perf case catalog ok (disk, imports, and cases array agree).");
};

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exitCode = 1;
});
