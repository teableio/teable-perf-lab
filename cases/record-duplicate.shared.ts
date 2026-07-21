import { Colors, FieldType } from "@teable/core";
import type { RecordDuplicateSingleCaseConfig } from "../framework/types";

type DuplicateField = RecordDuplicateSingleCaseConfig["fields"][number];
type DuplicateFields = RecordDuplicateSingleCaseConfig["fields"];

const palette = [
  Colors.BlueBright,
  Colors.GreenBright,
  Colors.OrangeBright,
  Colors.PurpleBright,
  Colors.CyanBright,
];

const selectChoices = (names: string[]) =>
  names.map((name, index) => ({
    name,
    color: palette[index % palette.length],
  }));

const titleField = (): DuplicateField => ({
  name: "Title",
  type: FieldType.SingleLineText,
});

const withNineFields = (
  buildField: (index: number) => DuplicateField,
): DuplicateFields => [
  titleField(),
  ...Array.from({ length: 9 }, (_, index) => buildField(index + 1)),
];

const withOneHundredFields = (
  buildField: (index: number) => DuplicateField,
): DuplicateFields => [
  titleField(),
  ...Array.from({ length: 99 }, (_, index) => buildField(index + 1)),
];

const numberedName = (prefix: string, index: number) =>
  `${prefix} ${String(index).padStart(2, "0")}`;

const primaryOnly: DuplicateFields = [titleField()];

const singleLineText10 = withNineFields((index) => ({
  name: numberedName("Text", index),
  type: FieldType.SingleLineText,
}));

const longText10 = withNineFields((index) => ({
  name: numberedName("Long Text", index),
  type: FieldType.LongText,
}));

const number10 = withNineFields((index) => ({
  name: numberedName("Number", index),
  type: FieldType.Number,
}));

const date10 = withNineFields((index) => ({
  name: numberedName("Date", index),
  type: FieldType.Date,
  options: {
    formatting: {
      date: "YYYY-MM-DD",
      time: "None",
      timeZone: "UTC",
    },
  },
}));

const checkbox10 = withNineFields((index) => ({
  name: numberedName("Checkbox", index),
  type: FieldType.Checkbox,
}));

const singleSelect10 = withNineFields((index) => ({
  name: numberedName("Single Select", index),
  type: FieldType.SingleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma"]),
  },
}));

const multipleSelect10 = withNineFields((index) => ({
  name: numberedName("Multiple Select", index),
  type: FieldType.MultipleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma", "Delta"]),
  },
}));

const rating10 = withNineFields((index) => ({
  name: numberedName("Rating", index),
  type: FieldType.Rating,
  options: {
    icon: "star",
    color: Colors.YellowBright,
    max: 5,
  },
}));

const singleLineText100 = withOneHundredFields((index) => ({
  name: numberedName("Text", index),
  type: FieldType.SingleLineText,
}));

const longText100 = withOneHundredFields((index) => ({
  name: numberedName("Long Text", index),
  type: FieldType.LongText,
}));

const number100 = withOneHundredFields((index) => ({
  name: numberedName("Number", index),
  type: FieldType.Number,
}));

const date100 = withOneHundredFields((index) => ({
  name: numberedName("Date", index),
  type: FieldType.Date,
  options: {
    formatting: {
      date: "YYYY-MM-DD",
      time: "None",
      timeZone: "UTC",
    },
  },
}));

const checkbox100 = withOneHundredFields((index) => ({
  name: numberedName("Checkbox", index),
  type: FieldType.Checkbox,
}));

const singleSelect100 = withOneHundredFields((index) => ({
  name: numberedName("Single Select", index),
  type: FieldType.SingleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma"]),
  },
}));

const multipleSelect100 = withOneHundredFields((index) => ({
  name: numberedName("Multiple Select", index),
  type: FieldType.MultipleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma", "Delta"]),
  },
}));

const rating100 = withOneHundredFields((index) => ({
  name: numberedName("Rating", index),
  type: FieldType.Rating,
  options: {
    icon: "star",
    color: Colors.YellowBright,
    max: 5,
  },
}));

const mixed20: DuplicateFields = [
  titleField(),
  { name: "Description", type: FieldType.LongText },
  {
    name: "Status",
    type: FieldType.SingleSelect,
    options: { choices: selectChoices(["Todo", "Doing", "Done"]) },
  },
  {
    name: "Priority",
    type: FieldType.SingleSelect,
    options: { choices: selectChoices(["P0", "P1", "P2"]) },
  },
  {
    name: "Tags",
    type: FieldType.MultipleSelect,
    options: {
      choices: selectChoices(["Alpha", "Beta", "Gamma", "Delta"]),
    },
  },
  { name: "Amount", type: FieldType.Number },
  { name: "Quantity", type: FieldType.Number },
  {
    name: "Start Date",
    type: FieldType.Date,
    options: {
      formatting: { date: "YYYY-MM-DD", time: "None", timeZone: "UTC" },
    },
  },
  {
    name: "Due Date",
    type: FieldType.Date,
    options: {
      formatting: { date: "YYYY-MM-DD", time: "None", timeZone: "UTC" },
    },
  },
  { name: "Active", type: FieldType.Checkbox },
  {
    name: "Score",
    type: FieldType.Rating,
    options: { icon: "star", color: Colors.YellowBright, max: 5 },
  },
  { name: "Owner Text", type: FieldType.SingleLineText },
  { name: "Notes", type: FieldType.LongText },
  {
    name: "Category",
    type: FieldType.SingleSelect,
    options: { choices: selectChoices(["A", "B", "C"]) },
  },
  {
    name: "Labels",
    type: FieldType.MultipleSelect,
    options: { choices: selectChoices(["Red", "Blue", "Green"]) },
  },
  { name: "External ID", type: FieldType.SingleLineText },
  { name: "Source", type: FieldType.SingleLineText },
  { name: "Percent", type: FieldType.Number },
  { name: "Approved", type: FieldType.Checkbox },
  { name: "Comment", type: FieldType.LongText },
];

export const recordDuplicateSingle50Fields = {
  primaryOnly,
  singleLineText10,
  longText10,
  number10,
  date10,
  checkbox10,
  singleSelect10,
  multipleSelect10,
  rating10,
  mixed20,
};

export const recordDuplicateSingle500WideFields = {
  singleLineText100,
  longText100,
  number100,
  date100,
  checkbox100,
  singleSelect100,
  multipleSelect100,
  rating100,
};

export const recordDuplicateSingle50Base = {
  baseId: "seed-base",
  rowCount: 100,
  batchSize: 100,
  generator: {
    type: "flat-table-operation",
    titlePrefix: "Duplicate row",
    payloadPrefix: "duplicate",
    groups: ["A", "B", "C", "D", "E"],
  },
  duplicate: {
    sourceRowCount: 50,
  },
  verify: {
    sampleRows: [0, 24, 49],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  RecordDuplicateSingleCaseConfig,
  "baseId" | "rowCount" | "batchSize" | "generator" | "duplicate" | "verify"
>;

export const recordDuplicateSingle500Base = {
  ...recordDuplicateSingle50Base,
  rowCount: 1_000,
  batchSize: 1_000,
  duplicate: {
    sourceRowCount: 500,
  },
  verify: {
    sampleRows: [0, 249, 499],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  RecordDuplicateSingleCaseConfig,
  "baseId" | "rowCount" | "batchSize" | "generator" | "duplicate" | "verify"
>;
