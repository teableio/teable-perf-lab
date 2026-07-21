import { Colors, FieldType } from "@teable/core";
import type { IFieldRo } from "@teable/core";

export type ScalarMatrixField = IFieldRo & { id?: string; name: string };
export type ScalarMatrixFields = ScalarMatrixField[];

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

const titleField = (): ScalarMatrixField => ({
  name: "Title",
  type: FieldType.SingleLineText,
});

const numberedName = (prefix: string, index: number) =>
  `${prefix} ${String(index).padStart(2, "0")}`;

const numberedFields = (
  fieldCount: number,
  buildField: (index: number) => ScalarMatrixField,
): ScalarMatrixFields =>
  Array.from({ length: fieldCount }, (_, index) => buildField(index + 1));

const withFields = (
  fieldCount: number,
  buildField: (index: number) => ScalarMatrixField,
): ScalarMatrixFields => [
  titleField(),
  ...numberedFields(fieldCount - 1, buildField),
];

const singleLineTextField = (index: number): ScalarMatrixField => ({
  name: numberedName("Text", index),
  type: FieldType.SingleLineText,
});

const longTextField = (index: number): ScalarMatrixField => ({
  name: numberedName("Long Text", index),
  type: FieldType.LongText,
});

const numberField = (index: number): ScalarMatrixField => ({
  name: numberedName("Number", index),
  type: FieldType.Number,
});

const dateField = (index: number): ScalarMatrixField => ({
  name: numberedName("Date", index),
  type: FieldType.Date,
  options: {
    formatting: {
      date: "YYYY-MM-DD",
      time: "None",
      timeZone: "UTC",
    },
  },
});

const checkboxField = (index: number): ScalarMatrixField => ({
  name: numberedName("Checkbox", index),
  type: FieldType.Checkbox,
});

const singleSelectField = (index: number): ScalarMatrixField => ({
  name: numberedName("Single Select", index),
  type: FieldType.SingleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma"]),
  },
});

const multipleSelectField = (index: number): ScalarMatrixField => ({
  name: numberedName("Multiple Select", index),
  type: FieldType.MultipleSelect,
  options: {
    choices: selectChoices(["Alpha", "Beta", "Gamma", "Delta"]),
  },
});

const ratingField = (index: number): ScalarMatrixField => ({
  name: numberedName("Rating", index),
  type: FieldType.Rating,
  options: {
    icon: "star",
    color: Colors.YellowBright,
    max: 5,
  },
});

const primaryOnly: ScalarMatrixFields = [titleField()];

const singleLineText10 = withFields(10, singleLineTextField);
const longText10 = withFields(10, longTextField);
const number10 = withFields(10, numberField);
const date10 = withFields(10, dateField);
const checkbox10 = withFields(10, checkboxField);
const singleSelect10 = withFields(10, singleSelectField);
const multipleSelect10 = withFields(10, multipleSelectField);
const rating10 = withFields(10, ratingField);
const singleLineText20 = withFields(20, singleLineTextField);

const singleLineText100 = withFields(100, singleLineTextField);
const longText100 = withFields(100, longTextField);
const number100 = withFields(100, numberField);
const date100 = withFields(100, dateField);
const checkbox100 = withFields(100, checkboxField);
const singleSelect100 = withFields(100, singleSelectField);
const multipleSelect100 = withFields(100, multipleSelectField);
const rating100 = withFields(100, ratingField);

export const scalarFieldMatrix = {
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

export const scalarFieldMatrix100 = {
  singleLineText100,
  longText100,
  number100,
  date100,
  checkbox100,
  singleSelect100,
  multipleSelect100,
  rating100,
};

// Field-add workloads need only the new columns, without an existing primary
// field. Keep the same names and options as the table-shape matrix while making
// the request count explicit.
export const scalarFieldAddMatrix = {
  singleLineText1: numberedFields(1, singleLineTextField),
  singleLineText10: numberedFields(10, singleLineTextField),
  longText10: numberedFields(10, longTextField),
  number10: numberedFields(10, numberField),
  date10: numberedFields(10, dateField),
  checkbox10: numberedFields(10, checkboxField),
  singleSelect10: numberedFields(10, singleSelectField),
  multipleSelect10: numberedFields(10, multipleSelectField),
  rating10: numberedFields(10, ratingField),
  singleLineText20: numberedFields(20, singleLineTextField),
};
