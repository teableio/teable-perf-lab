import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const collectTypeScriptFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) return collectTypeScriptFiles(path);
        return entry.isFile() && path.endsWith(".ts") ? [path] : [];
      }),
    )
  ).flat();
};

const backgroundStepPattern =
  /\b(seedBuild|seedBatch|warmup|setup|verify|verification|ready)\b/i;
const repeatedStepPattern = /\b(iteration|sample|padIndex)\b/;
const violations = [];

const isInsideLoop = (node) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
    if (
      ts.isForStatement(parent) ||
      ts.isForInStatement(parent) ||
      ts.isForOfStatement(parent) ||
      ts.isWhileStatement(parent) ||
      ts.isDoStatement(parent)
    ) {
      return true;
    }
  }
  return false;
};

for (const file of await collectTypeScriptFiles("framework/runners")) {
  const source = ts.createSourceFile(
    file,
    await readFile(file, "utf8"),
    ts.ScriptTarget.ES2022,
    true,
  );

  const visit = (node) => {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "withPerfTraceStep"
    ) {
      const stepText = node.arguments[2]?.getText(source) ?? "";
      const { line } = source.getLineAndCharacterOfPosition(node.getStart());

      if (backgroundStepPattern.test(stepText)) {
        violations.push(
          `${file}:${line + 1} background step marked as a Tested Interface: ${stepText}`,
        );
      }

      if (
        (repeatedStepPattern.test(stepText) || isInsideLoop(node)) &&
        node.arguments.length < 5
      ) {
        violations.push(
          `${file}:${line + 1} repeated Tested Interface lacks a checkpoint declaration: ${stepText}`,
        );
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

assert.deepEqual(violations, []);
console.log("Trace scope checks ok");
