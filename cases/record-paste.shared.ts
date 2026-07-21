import { Colors, FieldType } from "@teable/core";
import type { RecordPasteCaseConfig } from "../framework/types";

type PasteField = RecordPasteCaseConfig["fields"][number];
type PasteFields = RecordPasteCaseConfig["fields"];

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

const titleField = (): PasteField => ({
  name: "Title",
  type: FieldType.SingleLineText,
});

const withNineFields = (
  buildField: (index: number) => PasteField,
): PasteFields => [
  titleField(),
  ...Array.from({ length: 9 }, (_, index) => buildField(index + 1)),
];

const numberedName = (prefix: string, index: number) =>
  `${prefix} ${String(index).padStart(2, "0")}`;

const primaryOnly: PasteFields = [titleField()];

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

const mixed20: PasteFields = [
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

export const recordPaste1kFields = {
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

export const recordPaste1kBase = {
  baseId: "seed-base",
  rowCount: 1_000,
  maxPasteCells: 20_000,
  generator: {
    type: "mixed-copy-paste",
    titlePrefix: "Paste row",
    groups: ["A", "B", "C", "D", "E"],
    payloadPrefix: "paste",
    valuePrefix: "Cell",
  },
  verify: {
    sampleRows: [0, 499, 999],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  RecordPasteCaseConfig,
  "baseId" | "rowCount" | "maxPasteCells" | "generator" | "verify"
>;

export const recordPaste5kBase = {
  ...recordPaste1kBase,
  rowCount: 5_000,
  maxPasteCells: 50_000,
  verify: {
    sampleRows: [0, 2_499, 4_999],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  RecordPasteCaseConfig,
  "baseId" | "rowCount" | "maxPasteCells" | "generator" | "verify"
>;
