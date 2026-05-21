import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

const collectTsFiles = async (dir) => {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        return collectTsFiles(path);
      }
      return entry.isFile() && path.endsWith(".ts") ? [path] : [];
    }),
  );

  return files.flat();
};

const tsFiles = [
  "perf-lab.e2e-spec.ts",
  "registry.ts",
  ...(await collectTsFiles("cases")),
  ...(await collectTsFiles("framework")),
].sort();

for (const file of tsFiles) {
  const source = await readFile(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: file,
    reportDiagnostics: true,
  });
  const diagnostics = output.diagnostics ?? [];
  const errors = diagnostics.filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );

  if (errors.length > 0) {
    const formatted = ts.formatDiagnosticsWithColorAndContext(errors, {
      getCanonicalFileName: (path) => path,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    });
    console.error(formatted);
    process.exit(1);
  }
}

console.log(`TypeScript syntax ok (${tsFiles.length} files)`);
