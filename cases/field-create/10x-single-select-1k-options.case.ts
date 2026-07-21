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
  id: "field-create/10x-single-select-1k-options",
  title: "Create 10 single-select fields with 1k options each",
  runner: "field-create",
  timeoutMs: 900_000,
  watchdogMs: 300_000,
  runtimeEnv: {
    PERF_LAB_TRACE_INCLUDE_STEP_PATTERN: "^createScalarFieldsMs:(1|5|10)$",
    PERF_LAB_TRACE_FALLBACK_STEP_PATTERN: "^createScalarFieldsMs:\\d+$",
  },
  config: {
    baseId: "seed-base",
    tableNamePrefix: "perf-field-create-10x-single-select-1k-options",
    seedIdentity: "empty-primary-field-create",
    baseFields: [{ name: "Title", type: FieldType.SingleLineText }],
    fields: Array.from({ length: 10 }, (_, index) => ({
      name: `Status ${String(index + 1).padStart(2, "0")} 1k Options`,
      type: FieldType.SingleSelect,
      options: { choices: selectChoices },
    })),
    tracePerField: true,
    verify: {
      optionCount: 1_000,
      sampleOptionIndexes: [0, 499, 999],
    },
    threshold: { metric: "createScalarFieldsMs", maxMs: 20_000 },
  },
});
