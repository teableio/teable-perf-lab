import { readFile } from "node:fs/promises";
import ts from "typescript";

const tsFiles = [
  "cases/perf-lab.e2e-spec.ts",
  "cases/registry.ts",
  "cases/smoke/auth-user.case.ts",
  "cases/formula/10k-calc.case.ts",
  "cases/formula/10k-5-concurrent.case.ts",
  "cases/lookup/conditional-10k.case.ts",
  "cases/framework/artifacts.ts",
  "cases/framework/env.ts",
  "cases/framework/metrics.ts",
  "cases/framework/run-perf-case.ts",
  "cases/framework/types.ts",
  "cases/framework/runners/conditional-lookup.runner.ts",
  "cases/framework/runners/http-endpoint.runner.ts",
  "cases/framework/runners/formula-table.runner.ts",
];

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
