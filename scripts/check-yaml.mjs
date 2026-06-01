import { readFile } from "node:fs/promises";
import { parse } from "yaml";

const yamlFiles = [
  ".github/workflows/teable-ee-e2e-perf.yml",
  ".github/workflows/sync-perf-cases.yml",
];

for (const file of yamlFiles) {
  parse(await readFile(file, "utf8"));
}

console.log(`YAML ok (${yamlFiles.length} files)`);
