import assert from "node:assert/strict";
import {
  CONFIRMED_STRICT_MIN_POINTS,
  preferredCorpusSegment,
} from "./corpus-compatibility-model.mjs";

const points = (length) => Array.from({ length }, (_, index) => [index, 100]);

assert.deepEqual(
  preferredCorpusSegment({
    segments: [points(100), points(CONFIRMED_STRICT_MIN_POINTS)],
    segmentCompatibility: ["legacy", "strict"],
    measurementIdentityAvailable: true,
  }),
  { index: 1, mode: "strict" },
);
assert.deepEqual(
  preferredCorpusSegment({
    segments: [points(100), points(CONFIRMED_STRICT_MIN_POINTS - 1)],
    segmentCompatibility: ["legacy", "strict"],
    measurementIdentityAvailable: true,
  }),
  { index: 0, mode: "legacy-fallback" },
);
assert.deepEqual(
  preferredCorpusSegment({
    segments: [points(20), points(CONFIRMED_STRICT_MIN_POINTS - 1)],
    segmentCompatibility: ["legacy", "strict"],
    measurementIdentityAvailable: true,
  }),
  { index: 0, mode: "legacy-fallback" },
);
assert.deepEqual(
  preferredCorpusSegment({
    segments: [points(CONFIRMED_STRICT_MIN_POINTS - 1)],
    segmentCompatibility: ["strict"],
    measurementIdentityAvailable: true,
  }),
  { index: 0, mode: "strict-insufficient" },
);
assert.deepEqual(
  preferredCorpusSegment({
    segments: [points(20)],
    segmentCompatibility: ["legacy"],
  }),
  { index: 0, mode: "legacy" },
);

console.log("corpus compatibility model checks passed");
