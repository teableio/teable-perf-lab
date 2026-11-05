import { describe, expect, it } from 'vitest';
import { generateTableRows } from './recipe';

const fields = {
  Name: { type: 'singleLineText', isComputed: false, isPrimary: true },
  Value: { type: 'number', isComputed: false },
  Parent: { type: 'link', isComputed: false },
  Formula: { type: 'formula', isComputed: true },
} as const;

describe('generateTableRows', () => {
  it('produces identical rows for the same seed and omits computed fields', () => {
    const input = {
      table: 'Items',
      rows: 3,
      fields,
      targetRowCounts: { Parents: 5 },
      seed: 7,
      recipe: {
        fields: { Parent: { link: { table: 'Parents', relationship: 'manyOne' as const } } },
      },
    };
    expect(generateTableRows(input)).toEqual(generateTableRows(input));
    expect(generateTableRows(input)[0]?.fields).not.toHaveProperty('Formula');
  });

  it('applies nullFraction to nullable primary and non-primary values', () => {
    const rows = generateTableRows({
      table: 'Items',
      rows: 2,
      fields,
      targetRowCounts: {},
      seed: 1,
      recipe: { fields: { Name: { nullFraction: 1 }, Value: { nullFraction: 1 } } },
    });
    expect(rows.map((row) => row.fields.Value)).toEqual([null, null]);
    expect(rows.map((row) => row.fields.Name)).toEqual([null, null]);
  });

  it('chooses distinct indices for many-many fanout', () => {
    const rows = generateTableRows({
      table: 'Items',
      rows: 2,
      fields,
      targetRowCounts: { Parents: 4 },
      seed: 9,
      recipe: {
        fields: { Parent: { link: { table: 'Parents', relationship: 'manyMany', fanout: 3 } } },
      },
    });
    expect(new Set(rows[0]?.links.Parent?.targetIndices).size).toBe(3);
  });

  it('keeps generated text primaries unique past single digits', () => {
    const rows = generateTableRows({
      table: 'Items',
      rows: 120,
      fields,
      targetRowCounts: {},
      seed: 3,
      recipe: undefined,
    });
    const names = rows.map((row) => row.fields.Name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('rejects fanout greater than target rows', () => {
    expect(() =>
      generateTableRows({
        table: 'Items',
        rows: 1,
        fields,
        targetRowCounts: { Parents: 2 },
        seed: 1,
        recipe: {
          fields: { Parent: { link: { table: 'Parents', relationship: 'manyMany', fanout: 3 } } },
        },
      })
    ).toThrow(/bench\.recipe\.fanout_exceeds_rows/);
  });

  it('derives select values from schema choices and rejects unknown recipe choices', () => {
    const selectFields = {
      Name: fields.Name,
      Status: {
        type: 'singleSelect',
        isComputed: false,
        choices: ['Ready', 'Done'],
      },
    } as const;
    const rows = generateTableRows({
      table: 'Items',
      rows: 5,
      fields: selectFields,
      targetRowCounts: {},
      seed: 4,
      recipe: undefined,
    });
    expect(rows.every((row) => row.fields.Status === 'Ready' || row.fields.Status === 'Done')).toBe(
      true
    );

    expect(() =>
      generateTableRows({
        table: 'Items',
        rows: 1,
        fields: selectFields,
        targetRowCounts: {},
        seed: 4,
        recipe: { fields: { Status: { choices: ['Missing'] } } },
      })
    ).toThrow(/bench\.recipe\.choice_unknown/);
  });

  it('uses the runtime actor for single and multiple user value shapes', () => {
    const rows = generateTableRows({
      table: 'Items',
      rows: 1,
      fields: {
        Name: fields.Name,
        Owner: { type: 'user', isComputed: false },
        Reviewers: { type: 'user', isComputed: false, isMultiple: true },
      },
      targetRowCounts: {},
      seed: 2,
      actorId: 'usr_runtime_actor',
      recipe: undefined,
    });
    expect(rows[0]?.fields.Owner).toEqual({ id: 'usr_runtime_actor' });
    expect(rows[0]?.fields.Reviewers).toEqual([{ id: 'usr_runtime_actor' }]);
  });

  it('never invents select options when the schema has no choices', () => {
    const rows = generateTableRows({
      table: 'Items',
      rows: 1,
      fields: {
        Name: fields.Name,
        Status: { type: 'singleSelect', isComputed: false, choices: [] },
      },
      targetRowCounts: {},
      seed: 4,
      recipe: undefined,
    });
    expect(rows[0]?.fields.Status).toBeNull();
  });

  it('allows an empty-options nullable select primary and honors rating maxima', () => {
    const rows = generateTableRows({
      table: 'Items',
      rows: 64,
      fields: {
        Name: {
          type: 'singleSelect',
          isComputed: false,
          isPrimary: true,
          choices: [],
        },
        OneStar: { type: 'rating', isComputed: false, ratingMax: 1 },
        ThreeStars: { type: 'rating', isComputed: false, ratingMax: 3 },
      },
      targetRowCounts: {},
      seed: 4,
      recipe: undefined,
    });
    expect(rows.every((row) => row.fields.Name === null)).toBe(true);
    expect(rows.every((row) => row.fields.OneStar === 1)).toBe(true);
    const threeStars = rows.map((row) => row.fields.ThreeStars as number);
    expect(threeStars.every((value) => Number.isInteger(value) && value >= 1 && value <= 3)).toBe(
      true
    );
    expect(Math.max(...threeStars)).toBe(3);
  });

  it('rejects missing runtime actors', () => {
    expect(() =>
      generateTableRows({
        table: 'Items',
        rows: 1,
        fields: { Owner: { type: 'user', isComputed: false } },
        targetRowCounts: {},
        seed: 1,
        recipe: undefined,
      })
    ).toThrow(/bench\.recipe\.actor_missing/);
  });
});
