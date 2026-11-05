import { describe, expect, it } from 'vitest';
import { resolveDataQueryDefinition, resolveRecordQuery } from './resolveQuery';
import type { ResolvedField, ResolvedTable } from './types';

const amount: ResolvedField = {
  id: 'fld_runtime_amount',
  declaredId: 'fld_declared_amount',
  name: 'Amount',
  type: 'number',
  isComputed: false,
  isPrimary: false,
  isMultiple: false,
};
const title: ResolvedField = {
  id: 'fld_runtime_title',
  name: 'Title',
  type: 'singleLineText',
  isComputed: false,
  isPrimary: true,
  isMultiple: false,
};
const orders: ResolvedTable = {
  id: 'tbl_runtime_orders',
  declaredId: 'tbl_declared_orders',
  name: 'Orders',
  primaryFieldName: 'Title',
  fields: new Map([
    ['Amount', amount],
    ['Title', title],
  ]),
};

describe('resolveRecordQuery', () => {
  it('resolves field names recursively in filters and query lists', () => {
    expect(
      resolveRecordQuery({
        table: orders,
        filter: {
          conjunction: 'and',
          filterSet: [{ fieldId: 'Amount', operator: 'isGreater', value: 1 }],
        },
        sort: [{ fieldId: 'fld_declared_amount', order: 'desc' }],
        projection: ['Title'],
      })
    ).toEqual({
      filter: {
        conjunction: 'and',
        filterSet: [{ fieldId: 'fld_runtime_amount', operator: 'isGreater', value: 1 }],
      },
      sort: [{ fieldId: 'fld_runtime_amount', order: 'desc' }],
      projection: ['fld_runtime_title'],
    });
  });

  it('rejects an unknown field', () => {
    expect(() => resolveRecordQuery({ table: orders, projection: ['Missing'] })).toThrow(
      /bench\.field\.unknown/
    );
  });
});

describe('resolveDataQueryDefinition', () => {
  it('resolves table and field references without rewriting aliases or values', () => {
    const definition = {
      source: 'orders',
      tableId: 'Orders',
      projection: [{ fieldId: 'Amount', alias: 'tableId', value: 'Amount' }],
    };
    expect(
      resolveDataQueryDefinition({
        definition,
        tables: new Map([['Orders', orders]]),
        fields: new Map([
          ['Amount', amount],
          ['Title', title],
        ]),
      })
    ).toEqual({
      source: 'orders',
      tableId: 'tbl_runtime_orders',
      projection: [{ fieldId: 'fld_runtime_amount', alias: 'tableId', value: 'Amount' }],
    });
  });

  it('rejects an ambiguous global field name', () => {
    const duplicate = { ...amount, id: 'fld_other' };
    expect(() =>
      resolveDataQueryDefinition({
        definition: { fieldId: 'Amount' },
        tables: new Map([['Orders', orders]]),
        fields: new Map([
          ['one', amount],
          ['two', duplicate],
        ]),
      })
    ).toThrow(/bench\.field\.ambiguous/);
  });
});
