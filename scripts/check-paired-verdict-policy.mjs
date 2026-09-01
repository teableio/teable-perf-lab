import assert from "node:assert/strict";
import { exitCodeForPairedVerdict } from "./paired-verdict-policy.mjs";

assert.equal(exitCodeForPairedVerdict("pass"), 0);
assert.equal(exitCodeForPairedVerdict("regression"), 1);
assert.equal(exitCodeForPairedVerdict("candidate"), 2);
assert.equal(exitCodeForPairedVerdict("inconclusive"), 2);
assert.equal(exitCodeForPairedVerdict("unknown"), 2);

console.log("paired verdict policy checks passed");
