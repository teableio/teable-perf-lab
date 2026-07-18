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

const withFields = (
  fieldCount: number,
  buildField: (index: number) => ScalarMatrixField,
): ScalarMatrixFields => [
  titleField(),
  ...Array.from({ length: fieldCount - 1 }, (_, index) =>
    buildField(index + 1),
  ),
];

const primaryOnly: ScalarMatrixFields = [titleField()];

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
