import assert from "node:assert/strict";
import { planPerformanceTrackSchema } from "./performance-track-schema-model.mjs";

assert.deepEqual(planPerformanceTrackSchema([]), {
  create: [{ name: "Measurement JSON", type: "longText" }],
  incompatible: [],
});

assert.deepEqual(
  planPerformanceTrackSchema([
    { id: "fld-existing", name: "Measurement JSON", type: "longText" },
  ]),
  { create: [], incompatible: [] },
);

assert.deepEqual(
  planPerformanceTrackSchema([
    { id: "fld-wrong", name: "Measurement JSON", type: "singleLineText" },
  ]),
  {
    create: [],
    incompatible: [
      {
        name: "Measurement JSON",
        expectedType: "longText",
        actualType: "singleLineText",
      },
    ],
  },
);

console.log("performance track schema model checks passed");
