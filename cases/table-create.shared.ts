import { Colors, FieldType } from "@teable/core";
import type { TableCreateCaseConfig } from "../framework/types";

type TableCreateField = TableCreateCaseConfig["fields"][number];
type TableCreateFields = TableCreateCaseConfig["fields"];

const palette = [
  Colors.BlueBright,
  Colors.GreenBright,
  Colors.OrangeBright,
  Colors.PurpleBright,
];

const selectChoices = (names: string[]) =>
  names.map((name, index) => ({
    name,
    color: palette[index % palette.length],
  }));

const titleField = (): TableCreateField => ({
  name: "Title",
  type: FieldType.SingleLineText,
});

const numberedName = (prefix: string, index: number) =>
  `${prefix} ${String(index).padStart(2, "0")}`;

const withFields = (
  fieldCount: number,
  buildField: (index: number) => TableCreateField,
): TableCreateFields => [
  titleField(),
  ...Array.from({ length: fieldCount - 1 }, (_, index) =>
    buildField(index + 1),
  ),
];

const primaryOnly: TableCreateFields = [titleField()];

const singleLineText10 = withFields(10, (index) => ({
  name: numberedName("Text", index),
  type: FieldType.SingleLineText,
}));

const longText10 = withFields(10, (index) => ({
  name: numberedName("Long Text", index),
  type: FieldType.LongText,
}));

const number10 = withFields(10, (index) => ({
  name: numberedName("Number", index),
  type: FieldType.Number,
}));

const date10 = withFields(10, (index) => ({
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

const checkbox10 = withFields(10, (index) => ({
  name: numberedName("Checkbox", index),
  type: FieldType.Checkbox,
}));

const singleSelect10 = withFields(10, (index) => ({
  name: numberedName("Single Select", index),
  type: FieldType.SingleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma"]),
  },
}));

const multipleSelect10 = withFields(10, (index) => ({
  name: numberedName("Multiple Select", index),
  type: FieldType.MultipleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma", "Delta"]),
  },
}));

const rating10 = withFields(10, (index) => ({
  name: numberedName("Rating", index),
  type: FieldType.Rating,
  options: {
    icon: "star",
    color: Colors.YellowBright,
    max: 5,
  },
}));

const singleLineText20 = withFields(20, (index) => ({
  name: numberedName("Text", index),
  type: FieldType.SingleLineText,
}));

export const tableCreate1kFields = {
  primaryOnly,
  singleLineText10,
  longText10,
  number10,
  date10,
  checkbox10,
  singleSelect10,
  multipleSelect10,
  rating10,
  singleLineText20,
};

export const tableCreate1kBase = {
  baseId: "seed-base",
  tableCount: 1,
  inlineRecords: {
    count: 1_000,
    titlePrefix: "Inline",
  },
  verify: {
    mode: "all-fields",
    sampleRows: [0, 499, 999],
    fullScanPageSize: 1_000,
  },
} satisfies Pick<
  TableCreateCaseConfig,
  "baseId" | "tableCount" | "inlineRecords" | "verify"
>;
