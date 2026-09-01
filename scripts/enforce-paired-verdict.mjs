import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { env } from "./env.mjs";
import { exitCodeForPairedVerdict } from "./paired-verdict-policy.mjs";

const path = resolve(
  env("PERF_LAB_PAIRED_VERDICT_PATH", "paired-verdict.json"),
);
const verdict = JSON.parse(await readFile(path, "utf8"));

const exitCode = exitCodeForPairedVerdict(verdict.status);
if (verdict.status === "regression") {
  console.error("Confirmed paired performance regression.");
} else if (verdict.status !== "pass") {
  console.error(
    `Paired performance experiment was ${verdict.status || "invalid"}; not a pass.`,
  );
} else {
  console.log(`Paired performance verdict: ${verdict.status}`);
}
process.exitCode = exitCode;
