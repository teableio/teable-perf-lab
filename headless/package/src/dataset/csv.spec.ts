import { describe, expect, it } from 'vitest';
import type { ResolvedTable } from '../case/types';
import { resolveCsvTable } from './csv';

const table: ResolvedTable = {
  id: 'tbl_runtime',
  name: 'Orders',
  primaryFieldName: 'Title',
  fields: new Map([
    [
      'Title',
      {
        id: 'fld_title',
        declaredId: 'fld_declared_title',
        name: 'Title',
        type: 'singleLineText',
        isComputed: false,
        isPrimary: true,
        isMultiple: false,
      },
    ],
    [
      'Amount',
      {
        id: 'fld_amount',
        name: 'Amount',
        type: 'number',
        isComputed: false,
        isPrimary: false,
        isMultiple: false,
      },
    ],
    [
      'Customer',
      {
        id: 'fld_customer',
        name: 'Customer',
        type: 'link',
        isComputed: false,
        isPrimary: false,
        isMultiple: true,
        link: { table: 'Customers', relationship: 'manyMany' },
      },
    ],
    [
      'Files',
      {
        id: 'fld_files',
        name: 'Files',
        type: 'attachment',
        isComputed: false,
        isPrimary: false,
        isMultiple: true,
      },
    ],
    [
      'Owner',
      {
        id: 'fld_owner',
        name: 'Owner',
        type: 'user',
        isComputed: false,
        isPrimary: false,
        isMultiple: false,
      },
    ],
    [
      'Reviewers',
      {
        id: 'fld_reviewers',
        name: 'Reviewers',
        type: 'user',
        isComputed: false,
        isPrimary: false,
        isMultiple: true,
      },
    ],
  ]),
};

describe('resolveCsvTable', () => {
  it('maps headers by name and declared id and parses numbers and link arrays', () => {
    const result = resolveCsvTable({
      tableName: 'Orders',
      table,
      csv: {
        header: ['fld_declared_title', 'Amount', 'Customer'],
        rows: [['A', '12.5', '["C1","C2"]']],
      },
    });
    expect(result.rows).toEqual([{ Title: 'A', Amount: 12.5 }]);
    expect(result.links.Customer).toEqual([['C1', 'C2']]);
  });

  it('rejects unknown headers', () => {
    expect(() =>
      resolveCsvTable({ tableName: 'Orders', table, csv: { header: ['Missing'], rows: [['x']] } })
    ).toThrow(/bench\.csv\.header_unknown/);
  });

  it('preserves attachment objects and uses strict user value shapes', () => {
    const result = resolveCsvTable({
      tableName: 'Orders',
      table,
      csv: {
        header: ['Title', 'Files', 'Owner', 'Reviewers'],
        rows: [
          [
            'A',
            '[{"id":"att1","name":"invoice.pdf"}]',
            '{"id":"usr_owner"}',
            '["usr_first",{"id":"usr_second"}]',
          ],
        ],
      },
    });
    expect(result.rows).toEqual([
      {
        Title: 'A',
        Files: [{ id: 'att1', name: 'invoice.pdf' }],
        Owner: { id: 'usr_owner' },
        Reviewers: [{ id: 'usr_first' }, { id: 'usr_second' }],
      },
    ]);
  });

  it('prefers an exact field name over another field declared id', () => {
    const colliding: ResolvedTable = {
      ...table,
      fields: new Map([
        ...table.fields,
        [
          'Named',
          {
            id: 'fld_named',
            declaredId: 'fld_other',
            name: 'Named',
            type: 'singleLineText',
            isComputed: false,
            isPrimary: false,
            isMultiple: false,
          },
        ],
        [
          'Other',
          {
            id: 'fld_other_runtime',
            declaredId: 'Named',
            name: 'Other',
            type: 'singleLineText',
            isComputed: false,
            isPrimary: false,
            isMultiple: false,
          },
        ],
      ]),
    };
    expect(
      resolveCsvTable({
        tableName: 'Orders',
        table: colliding,
        csv: { header: ['Named'], rows: [['by-name']] },
      }).rows
    ).toEqual([{ Named: 'by-name' }]);
  });

  it('rejects duplicate headers resolving to the same field', () => {
    expect(() =>
      resolveCsvTable({
        tableName: 'Orders',
        table,
        csv: { header: ['Title', 'fld_declared_title'], rows: [['A', 'B']] },
      })
    ).toThrow(/bench\.field\.ambiguous/);
  });

  it('rejects malformed JSON cells and inconsistent row widths', () => {
    expect(() =>
      resolveCsvTable({
        tableName: 'Orders',
        table,
        csv: { header: ['Files'], rows: [['[broken']] },
      })
    ).toThrow(/bench\.csv\.json_invalid/);
    expect(() =>
      resolveCsvTable({
        tableName: 'Orders',
        table,
        csv: { header: ['Title', 'Amount'], rows: [['A']] },
      })
    ).toThrow(/bench\.csv\.row_width_invalid/);
  });
});
