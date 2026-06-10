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
      maxMs: 30_000,
    },
  },
});
