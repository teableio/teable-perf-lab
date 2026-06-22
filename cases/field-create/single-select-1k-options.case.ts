import { Colors, FieldType } from "@teable/core";
import { definePerfCase } from "../../framework/types";

const choiceColors = [
  Colors.BlueBright,
  Colors.GreenBright,
  Colors.OrangeBright,
  Colors.PurpleBright,
  Colors.CyanBright,
  Colors.RedBright,
  Colors.TealBright,
  Colors.YellowBright,
];

const selectChoices = Array.from({ length: 1_000 }, (_, index) => ({
  name: `Option ${String(index + 1).padStart(4, "0")}`,
  color: choiceColors[index % choiceColors.length],
}));

export default definePerfCase({
  id: "field-create/single-select-1k-options",
  title: "Create a single select field with 1k options",
  runner: "field-create",
  timeoutMs: 180_000,
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-create-single-select-1k-options",
    baseFields: [{ name: "Title", type: FieldType.SingleLineText }],
    field: {
      name: "Status 1k Options",
      type: FieldType.SingleSelect,
      options: {
        choices: selectChoices,
      },
    },
    verify: {
      optionCount: 1_000,
      sampleOptionIndexes: [0, 499, 999],
    },
    threshold: {
      metric: "singleSelectCreateOptionsMs",
      // Calibrated 2026-06-22 from 196 CI runs (v1+v2, Apr-Jun 2026): p95 ~261ms,
      // worst ~358ms. Sub-second metric floored at 2_000ms (not 2x worst) to keep
      // headroom for CI variance on a noisy small metric (was 30_000).
      maxMs: 2_000,
    },
  },
});
