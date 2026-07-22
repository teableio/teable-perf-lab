#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import {
  evaluateFullRunFeedback,
  renderFullRunFeedback,
} from "./full-run-feedback-model.mjs";

const args = process.argv.slice(2);
const assertMode = args.includes("--assert");
const positionalArgs = args.filter((arg) => arg !== "--assert");

if (positionalArgs.length !== 1) {
  console.error(
    "Usage: node scripts/evaluate-full-run-feedback.mjs <telemetry.json> [--assert]",
  );
  process.exitCode = 2;
} else {
  try {
    const telemetry = JSON.parse(await readFile(positionalArgs[0], "utf8"));
    const evaluation = evaluateFullRunFeedback(telemetry);
    console.log(renderFullRunFeedback(evaluation));
    if (assertMode && !evaluation.passed) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
