// Complete synthetic field metadata for the 33-column historical table and
// its two new scalar fields. Generated DB names intentionally differ from the
// labels, so HTTP checks exercise the metadata resolver rather than defaults.
const original = [
  ["Case ID", "Case_ID", "singleLineText"],
  ["Primary Metric Value", "Primary_Metric_Value", "number"],
  ["Started At", "Started_At", "date"],
  ["Measurement JSON", "Measurement_JSON", "longText"],
  ["Status", "Status", "singleSelect"],
  ["Engine", "Engine", "singleLineText"],
  ["Run ID", "Run_ID", "singleLineText"],
  ...Array.from({ length: 26 }, (_, index) => [`Neutral ${index}`, `Neutral_${index}`, "singleLineText"]),
];
export const performanceTrackFieldsFixture = () => [
  ...original,
  ["Contract ID", "Contract_ID_generated_fixture", "singleLineText"],
  ["Environment Class", "Environment_Class_generated_fixture", "singleLineText"],
].map(([name, dbFieldName, type], index) => ({
  id: `fldSynthetic${String(index).padStart(8, "0")}`,
  name, dbFieldName, type, isComputed: false, isLookup: false,
}));
