// Full TypeScript type check for the perf lab sources.
//
// The perf lab files only resolve inside the teable-ee monorepo (they import
// "@teable/*" packages and reach outside the repo with relative paths like
// "../../../utils/init-app"). To type-check them standalone, this script
// copies the sources into a temp directory laid out like
// community/apps/nestjs-backend, stubs every external module as `any`, and
// runs the real type checker. External APIs are not validated, but all local
// types (framework/types.ts contracts, case configs, runner results) are.
import {
  cp,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, normalize, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

const EXTERNAL_MODULES = [
  "@nestjs/common",
  "@opentelemetry/api",
  "@teable/core",
  "@teable/db-main-prisma",
  "@teable/openapi",
  "@teable/v2-contract-http-implementation/handlers",
  "@teable/v2-core",
  "axios",
  "bcrypt",
  "nestjs-cls",
  "pg",
];

const VITEST_GLOBALS = [
  "describe",
  "it",
  "test",
  "expect",
  "beforeAll",
  "afterAll",
  "beforeEach",
  "afterEach",
];

// Resolved targets of the cross-repo relative imports, rooted at the temp
// directory standing in for community/apps/nestjs-backend.
const RELATIVE_MODULE_STUBS = [
  "test/utils/init-app",
  "src/tracing",
  "src/features/table/table-index.service",
  "src/features/v2/v2-container.service",
  "src/features/v2/v2-execution-context.factory",
];

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

// Scans every perf lab source for imports of external packages or of the
// cross-repo relative stub targets, and records which names each stub must
// export.
const collectStubExports = async (workspaceRoot, sourceFiles) => {
  const newStub = () => ({ named: new Set(), needsDefault: false });
  const relativeStubs = new Map(
    RELATIVE_MODULE_STUBS.map((stub) => [stub, newStub()]),
  );
  const externalStubs = new Map(
    EXTERNAL_MODULES.map((name) => [name, newStub()]),
  );

  for (const filePath of sourceFiles) {
    const source = ts.createSourceFile(
      filePath,
      await readFile(filePath, "utf8"),
      ts.ScriptTarget.ES2022,
      true,
    );

    for (const statement of source.statements) {
      if (
        !ts.isImportDeclaration(statement) ||
        !ts.isStringLiteral(statement.moduleSpecifier)
      ) {
        continue;
      }

      const specifier = statement.moduleSpecifier.text;
      let stub;
      if (specifier.startsWith(".")) {
        const resolved = normalize(
          relative(workspaceRoot, resolve(dirname(filePath), specifier)),
        ).split(sep);
        stub = relativeStubs.get(resolved.join("/"));
      } else {
        stub = externalStubs.get(specifier);
      }

      const clause = statement.importClause;
      if (!stub || !clause) {
        continue;
      }

      if (clause.name) {
        stub.needsDefault = true;
      }
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const element of clause.namedBindings.elements) {
          stub.named.add((element.propertyName ?? element.name).text);
        }
      }
    }
  }

  return { relativeStubs, externalStubs };
};

// Each imported name is declared both as a value and as a type so it works
// in either position; both resolve to `any`.
const buildStubBody = ({ named, needsDefault }) =>
  [
    "const anyValue: any = undefined;",
    ...(needsDefault ? ["export default anyValue;"] : []),
    ...[...named]
      .sort()
      .flatMap((name) => [
        `export const ${name}: any = anyValue;`,
        `export type ${name} = any;`,
      ]),
  ].join("\n");

const buildModuleStub = (stub) => `${buildStubBody(stub)}\n`;

const buildExternalShims = (externalStubs) =>
  [...externalStubs]
    .map(
      ([name, stub]) =>
        `declare module "${name}" {\n${buildStubBody(stub)
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n")}\n}`,
    )
    .join("\n\n") + "\n";

const buildGlobalShims = () =>
  [
    "declare var testConfig: { baseId: string; [key: string]: any };",
    ...VITEST_GLOBALS.map((name) => `declare const ${name}: any;`),
    "",
  ].join("\n");

const stageWorkspace = async (workspaceRoot) => {
  const perfLabRoot = join(workspaceRoot, "test", "perf-lab");
  await mkdir(perfLabRoot, { recursive: true });

  for (const entry of [
    "cases",
    "framework",
    "registry.ts",
    "perf-lab.e2e-spec.ts",
  ]) {
    await cp(join(repoRoot, entry), join(perfLabRoot, entry), {
      recursive: true,
    });
  }

  const sourceFiles = await collectTsFiles(perfLabRoot);
  const { relativeStubs, externalStubs } = await collectStubExports(
    workspaceRoot,
    sourceFiles,
  );

  for (const [stubPath, exports] of relativeStubs) {
    const target = join(workspaceRoot, `${stubPath}.ts`);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buildModuleStub(exports));
  }

  await writeFile(
    join(workspaceRoot, "external-modules.d.ts"),
    buildExternalShims(externalStubs),
  );
  await writeFile(join(workspaceRoot, "globals.d.ts"), buildGlobalShims());
};

const workspaceRoot = await mkdtemp(join(tmpdir(), "perf-lab-typecheck-"));

try {
  await stageWorkspace(workspaceRoot);

  const rootNames = await collectTsFiles(workspaceRoot);
  // Not strict: the sources were never written against strict mode, and the
  // any-typed stubs would trip noImplicitAny/unknown checks everywhere. The
  // goal is catching structural bugs against local types (e.g. a runner
  // returning an object missing PerfRunResult fields), which non-strict
  // checking covers.
  const program = ts.createProgram(rootNames, {
    strict: false,
    noEmit: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    esModuleInterop: true,
    skipLibCheck: true,
    types: ["node"],
    typeRoots: [join(repoRoot, "node_modules", "@types")],
  });

  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .filter(
      (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
    )
    // TS2347 ("Untyped function calls may not accept type arguments") only
    // fires against the any-typed stubs (e.g. axios.get<T>, client.query<T>);
    // with the real monorepo types those calls are fine.
    .filter((diagnostic) => diagnostic.code !== 2347);

  if (diagnostics.length > 0) {
    console.error(
      ts.formatDiagnosticsWithColorAndContext(diagnostics, {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => workspaceRoot,
        getNewLine: () => "\n",
      }),
    );
    console.error(
      `TypeScript type check failed (${diagnostics.length} errors)`,
    );
    process.exit(1);
  }

  const checkedFiles = rootNames.filter((file) =>
    file.includes(join("test", "perf-lab")),
  );
  console.log(`TypeScript types ok (${checkedFiles.length} files)`);
} finally {
  await rm(workspaceRoot, { recursive: true, force: true });
}
