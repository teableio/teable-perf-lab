import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
import ts from "typescript";

// record-trash.shared reaches Teable through `getTrashItems`. Mock that module
// while transpiling the real source in memory, so the scan's give-up diagnostics
// can be asserted inside perf-lab itself.
let trashPages = [];
let requestedCursors = [];

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@teable/openapi") {
      return { url: "mock:teable-openapi", shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !extname(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (url === "mock:teable-openapi") {
      return {
        format: "module",
        shortCircuit: true,
        source: `
          export const TrashType = { Table: "table" };
          export const TableTrashType = { Record: "record", Field: "field" };
          export const getTrashItems = async ({ cursor }) => {
            globalThis.__trashCursors.push(cursor ?? null);
            const page = globalThis.__trashPages.shift() ?? {
              trashItems: [],
              nextCursor: null,
            };
            return { data: page };
          };
        `,
      };
    }
    if (!url.endsWith(".ts")) {
      return nextLoad(url, context);
    }
    const source = readFileSync(fileURLToPath(url), "utf8");
    return {
      format: "module",
      shortCircuit: true,
      source: ts.transpileModule(source, {
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
        },
        fileName: fileURLToPath(url),
      }).outputText,
    };
  },
});

globalThis.__trashPages = trashPages;
globalThis.__trashCursors = requestedCursors;

const { findRecordTrashItems } = await import("./record-trash.shared.ts");

const setPages = (pages) => {
  globalThis.__trashPages = trashPages = [...pages];
  globalThis.__trashCursors = requestedCursors = [];
};

const recordItem = (id, resourceIds) => ({
  id,
  resourceType: "record",
  resourceIds,
  deletedTime: "2026-07-31T00:00:00.000Z",
});

const ids = (prefix, count, from = 0) =>
  Array.from({ length: count }, (_, index) => `${prefix}${from + index}`);

test("covers every deleted record across pages", async () => {
  setPages([
    { trashItems: [recordItem("t1", ids("rec", 20))], nextCursor: "c1" },
    { trashItems: [recordItem("t2", ids("rec", 20, 20))], nextCursor: null },
  ]);
  const lookups = await findRecordTrashItems("tbl1", ids("rec", 40));
  assert.equal(lookups.length, 2);
  assert.deepEqual(
    lookups.map((lookup) => lookup.scannedPages),
    [1, 2],
  );
  assert.deepEqual(requestedCursors, [null, "c1"]);
});

test("a short list reports no-cursor, not a page cap", async () => {
  setPages([
    { trashItems: [recordItem("t1", ids("rec", 20))], nextCursor: null },
  ]);
  await assert.rejects(
    findRecordTrashItems("tbl1", ids("rec", 1000)),
    (error) => {
      assert.match(error.message, /cover 20\/1000 deleted records/);
      assert.match(error.message, /scanned 1\/25 pages, stopped on no-cursor/);
      assert.match(error.message, /1\/1 record trash items/);
      assert.match(
        error.message,
        /0 mixed-batch items skipped covering 0 expected records/,
      );
      return true;
    },
  );
});

test("mixed batches are reported with the coverage they hide", async () => {
  // A trash item spanning this deletion's records and someone else's is
  // dropped whole by the every() filter. That loss used to be invisible.
  setPages([
    {
      trashItems: [
        recordItem("t1", ids("rec", 20)),
        recordItem("t2", [...ids("rec", 15, 20), ...ids("other", 5)]),
      ],
      nextCursor: null,
    },
  ]);
  await assert.rejects(
    findRecordTrashItems("tbl1", ids("rec", 40)),
    (error) => {
      assert.match(error.message, /cover 20\/40 deleted records/);
      assert.match(error.message, /2\/2 record trash items/);
      assert.match(
        error.message,
        /1 mixed-batch items skipped covering 15 expected records/,
      );
      return true;
    },
  );
});

test("exhausting the page budget reports page-cap", async () => {
  setPages(
    Array.from({ length: 30 }, (_, index) => ({
      trashItems: [recordItem(`t${index}`, [`rec${index}`])],
      nextCursor: `c${index}`,
    })),
  );
  await assert.rejects(
    findRecordTrashItems("tbl1", ids("rec", 1000)),
    (error) => {
      assert.match(error.message, /scanned 25\/25 pages, stopped on page-cap/);
      return true;
    },
  );
});

test("non-record trash is excluded from the record-item count", async () => {
  setPages([
    {
      trashItems: [
        { id: "f1", resourceType: "field", resourceIds: ["fld1"] },
        recordItem("t1", ids("rec", 20)),
      ],
      nextCursor: null,
    },
  ]);
  await assert.rejects(
    findRecordTrashItems("tbl1", ids("rec", 40)),
    (error) => {
      assert.match(error.message, /1\/2 record trash items/);
      return true;
    },
  );
});
