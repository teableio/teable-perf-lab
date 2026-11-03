export const richDerivedStructure = {
  id: 'bse0000000000000001',
  tables: [
    {
      id: 'tbl0000000000000001',
      name: 'Parents',
      fields: [
        {
          id: 'fld0000000000000001',
          name: 'Name',
          type: 'singleLineText',
          isPrimary: true,
        },
        { id: 'fld0000000000000002', name: 'Amount', type: 'number' },
        {
          id: 'fld0000000000000003',
          name: 'Status',
          type: 'singleSelect',
          options: { choices: [{ name: 'Open' }, { name: 'Closed' }] },
        },
        {
          id: 'fld0000000000000004',
          name: 'Double',
          type: 'formula',
          options: { expression: '{fld0000000000000002} * 2' },
        },
        {
          id: 'fld0000000000000005',
          name: 'Label',
          type: 'formula',
          options: { expression: '{fld0000000000000004} + 1' },
        },
        {
          id: 'fld0000000000000006',
          name: 'Children',
          type: 'link',
          options: {
            relationship: 'manyMany',
            foreignTableId: 'tbl0000000000000002',
            lookupFieldId: 'fld0000000000000008',
            isOneWay: true,
          },
        },
        {
          id: 'fld0000000000000007',
          name: 'ChildTotal',
          type: 'rollup',
          options: { expression: 'sum({values})' },
          lookupOptions: {
            linkFieldId: 'fld0000000000000006',
            foreignTableId: 'tbl0000000000000002',
            lookupFieldId: 'fld0000000000000009',
          },
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    },
    {
      id: 'tbl0000000000000002',
      name: 'Children',
      fields: [
        {
          id: 'fld0000000000000008',
          name: 'Title',
          type: 'singleLineText',
          isPrimary: true,
        },
        { id: 'fld0000000000000009', name: 'Score', type: 'number' },
        {
          id: 'fld0000000000000010',
          name: 'Parent',
          type: 'link',
          options: {
            relationship: 'manyOne',
            foreignTableId: 'tbl0000000000000001',
            lookupFieldId: 'fld0000000000000001',
            isOneWay: true,
          },
        },
        {
          id: 'fld0000000000000011',
          name: 'ParentLabel',
          type: 'formula',
          isLookup: true,
          lookupOptions: {
            linkFieldId: 'fld0000000000000010',
            foreignTableId: 'tbl0000000000000001',
            lookupFieldId: 'fld0000000000000005',
          },
        },
        {
          id: 'fld0000000000000012',
          name: 'ParentStatus',
          type: 'singleSelect',
          isLookup: true,
          options: { choices: [{ name: 'Open' }, { name: 'Closed' }] },
          lookupOptions: {
            linkFieldId: 'fld0000000000000010',
            foreignTableId: 'tbl0000000000000001',
            lookupFieldId: 'fld0000000000000003',
          },
        },
        {
          id: 'fld0000000000000013',
          name: 'MatchingParents',
          type: 'singleLineText',
          isConditionalLookup: true,
          lookupOptions: {
            foreignTableId: 'tbl0000000000000001',
            lookupFieldId: 'fld0000000000000001',
            condition: {
              filterSet: [
                {
                  fieldId: 'fld0000000000000003',
                  operator: 'is',
                  value: 'Open',
                },
              ],
            },
          },
        },
      ],
      views: [{ type: 'grid', name: 'Grid' }],
    },
  ],
} as const;
