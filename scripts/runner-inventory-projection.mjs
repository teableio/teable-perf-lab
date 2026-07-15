import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

export const RUNNER_INVENTORY_START =
  "<!-- BEGIN GENERATED RUNNER INVENTORY -->";
export const RUNNER_INVENTORY_END = "<!-- END GENERATED RUNNER INVENTORY -->";

const unwrapExpression = (expression) => {
  let current = expression;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

const propertyName = (property, source) => {
  if (
    ts.isIdentifier(property.name) ||
    ts.isStringLiteral(property.name) ||
    ts.isNumericLiteral(property.name)
  ) {
    return property.name.text;
  }
  return property.name.getText(source);
};

const objectProperty = (object, name, source) =>
  object.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      propertyName(property, source) === name,
  );

const stringLiteralValue = (expression, label) => {
  if (!ts.isStringLiteral(expression)) {
    throw new Error(`Expected string literal for ${label}`);
  }
  return expression.text;
};

export const loadRunnerInventory = async (repoRoot) => {
  const registryPath = join(repoRoot, "framework", "runner-registry.ts");
  const text = await readFile(registryPath, "utf8");
  const source = ts.createSourceFile(
    registryPath,
    text,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );

  let inventory;
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (declaration.name.getText(source) === "runnerInventory") {
        inventory = unwrapExpression(declaration.initializer);
      }
    }
  }
  if (!inventory || !ts.isObjectLiteralExpression(inventory)) {
    throw new Error("Could not parse runnerInventory");
  }

  return inventory.properties.map((property) => {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error("runnerInventory only supports property assignments");
    }
    const runner = propertyName(property, source);
    const entry = unwrapExpression(property.initializer);
    if (!ts.isObjectLiteralExpression(entry)) {
      throw new Error(`Could not parse runnerInventory.${runner}`);
    }
    const implementationProperty = objectProperty(
      entry,
      "implementation",
      source,
    );
    if (!implementationProperty) {
      throw new Error(`Incomplete runner inventory entry: ${runner}`);
    }
    const implementation = unwrapExpression(implementationProperty.initializer);
    if (!ts.isObjectLiteralExpression(implementation)) {
      throw new Error(`Could not parse ${runner}.implementation`);
    }
    const modeProperty = objectProperty(implementation, "mode", source);
    if (!modeProperty) throw new Error(`Missing ${runner}.implementation.mode`);
    const mode = stringLiteralValue(
      modeProperty.initializer,
      `${runner}.implementation.mode`,
    );
    if (mode === "direct") return { runner, mode, drivers: [] };
    if (mode !== "lifecycle") {
      throw new Error(`Unsupported implementation mode for ${runner}: ${mode}`);
    }
    const driversProperty = objectProperty(implementation, "drivers", source);
    if (
      !driversProperty ||
      !ts.isArrayLiteralExpression(driversProperty.initializer) ||
      driversProperty.initializer.elements.length === 0
    ) {
      throw new Error(`Lifecycle runner ${runner} needs non-empty drivers`);
    }
    const drivers = driversProperty.initializer.elements.map((driver, index) =>
      stringLiteralValue(driver, `${runner}.implementation.drivers[${index}]`),
    );
    return { runner, mode, drivers };
  });
};

const parseCaseRunner = async (repoRoot, casePath) => {
  const text = await readFile(join(repoRoot, casePath), "utf8");
  const match = text.match(/runner:\s*["']([^"']+)["']/);
  if (!match) throw new Error(`Could not parse runner from ${casePath}`);
  return match[1];
};

export const buildRunnerInventorySection = async (
  repoRoot,
  registeredCasePaths,
) => {
  const inventory = await loadRunnerInventory(repoRoot);
  const caseCounts = new Map(inventory.map(({ runner }) => [runner, 0]));
  for (const casePath of registeredCasePaths) {
    const runner = await parseCaseRunner(repoRoot, casePath);
    if (!caseCounts.has(runner)) {
      throw new Error(`Registered case uses unknown runner: ${runner}`);
    }
    caseCounts.set(runner, caseCounts.get(runner) + 1);
  }

  const lifecycle = inventory.filter(({ mode }) => mode === "lifecycle");
  const direct = inventory.filter(({ mode }) => mode === "direct");
  const lifecycleCases = lifecycle.reduce(
    (total, { runner }) => total + caseCounts.get(runner),
    0,
  );
  const directCases = direct.reduce(
    (total, { runner }) => total + caseCounts.get(runner),
    0,
  );
  const rows = inventory.map(({ runner, mode, drivers }) => {
    const implementation =
      mode === "direct"
        ? "direct"
        : drivers.map((driver) => `\`${driver}\``).join(" + ");
    return [`\`${runner}\``, implementation, String(caseCounts.get(runner))];
  });
  const headers = ["Runner kind", "Implementation", "Registered cases"];
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index].length)),
  );
  const tableRows = [
    `| ${headers[0].padEnd(widths[0])} | ${headers[1].padEnd(widths[1])} | ${headers[2].padEnd(widths[2])} |`,
    `| ${"-".repeat(widths[0])} | ${"-".repeat(widths[1])} | ${"-".repeat(widths[2] - 1)}: |`,
    ...rows.map(
      (row) =>
        `| ${row[0].padEnd(widths[0])} | ${row[1].padEnd(widths[1])} | ${row[2].padStart(widths[2])} |`,
    ),
  ];

  return [
    RUNNER_INVENTORY_START,
    "",
    "<!-- Generated from framework/runner-registry.ts and registry.ts. -->",
    "<!-- Do not edit by hand; run `pnpm sync:readme` to regenerate. -->",
    "",
    `**Lifecycle: ${lifecycle.length} / ${inventory.length} runner kinds · ${lifecycleCases} / ${registeredCasePaths.length} cases. Direct: ${direct.length} runner kinds · ${directCases} cases.**`,
    "",
    ...tableRows,
    "",
    RUNNER_INVENTORY_END,
  ].join("\n");
};
