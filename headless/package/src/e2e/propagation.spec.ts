import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ActorId, UpdateRecordsCommand, type UpdateRecordsResult } from '@teable/v2-core';
import type { Result } from 'neverthrow';

import catalog from '../../fixtures/catalog.generator.json' with { type: 'json' };

import { parseBenchCaseManifest } from '../case/manifest';
import { loadCase } from '../case/TeaCaseLoader';
import type { LoadedCase, ResolvedTable } from '../case/types';
import { generateCases, type GeneratorSpec } from '../generator/generate';
import { normalizeValue } from '../oracle/normalize';
import { listAllRecords } from '../oracle/paging';
import { runCase } from '../runner/BenchRunner';

type CatalogCase = { manifestPath: string; teaPath: string };

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

const numericValue = (value: unknown): number | null => {
  const normalized = normalizeValue(value);
  return typeof normalized === 'number' ? normalized : null;
};

const lookupValues = (value: unknown): ReadonlyArray<number | null> => {
  const normalized = normalizeValue(value);
  if (normalized === null || normalized === undefined) return [];
  const entries = Array.isArray(normalized) ? normalized : [normalized];
  return entries.map(numericValue);
};

const sumNumbers = (values: ReadonlyArray<number | null>): number =>
  values.reduce<number>((sum, value) => sum + (value ?? 0), 0);

const readTable = async (
  loaded: LoadedCase,
  table: ResolvedTable
): Promise<ReadonlyArray<{ id: string; fields: Record<string, unknown> }>> => {
  const records = await listAllRecords({
    runtime: loaded.runtime,
    actorId: loaded.manifest.run.actorId,
    tableId: table.id,
    projection: [...table.fields.values()].map((field) => field.id),
  });
  return records.map((record) => ({
    id: String(record.id),
    fields: record.fields as Record<string, unknown>,
  }));
};

const fieldValue = (
  record: { fields: Record<string, unknown> },
  table: ResolvedTable,
  fieldName: string
): unknown => {
  const field = table.fields.get(fieldName);
  if (!field) throw new Error(`Missing field ${table.name}.${fieldName}`);
  return record.fields[field.id];
};

const updateField = async (input: {
  loaded: LoadedCase;
  table: ResolvedTable;
  fieldName: string;
  recordIds: ReadonlyArray<string>;
  values: ReadonlyArray<number>;
}): Promise<void> => {
  const field = input.table.fields.get(input.fieldName);
  if (!field) throw new Error(`Missing field ${input.table.name}.${input.fieldName}`);
  if (input.recordIds.length !== input.values.length) {
    throw new Error(
      `Value count does not match records for ${input.table.name}.${input.fieldName}`
    );
  }
  const actorId = unwrap(ActorId.create(input.loaded.manifest.run.actorId));
  unwrap(
    await input.loaded.runtime.commandBus.execute<UpdateRecordsCommand, UpdateRecordsResult>(
      { actorId },
      unwrap(
        UpdateRecordsCommand.create({
          tableId: input.table.id,
          fieldKeyType: 'id',
          typecast: false,
          records: input.recordIds.map((id, index) => ({
            id,
            fields: { [field.id]: input.values[index] },
          })),
        })
      )
    )
  );
};

describe('catalog propagation', () => {
  let outDir: string;
  let casesByMotif: Map<string, CatalogCase>;

  beforeAll(async () => {
    outDir = await mkdtemp(join(tmpdir(), 'headless-bench-propagation-'));
    const spec = catalog as unknown as GeneratorSpec;
    const generated = await generateCases({ ...spec, outDir });
    const manifests = await Promise.all(
      generated.cases.map(async (generatedCase) => ({
        generatedCase,
        manifest: parseBenchCaseManifest(
          JSON.parse(await readFile(generatedCase.manifestPath, 'utf8')) as unknown
        ),
      }))
    );
    casesByMotif = new Map();
    for (const entry of manifests) {
      const motif = entry.manifest.dimensions?.motif;
      if (typeof motif !== 'string' || casesByMotif.has(motif)) continue;
      casesByMotif.set(motif, {
        manifestPath: entry.generatedCase.manifestPath,
        teaPath: entry.generatedCase.teaPath,
      });
    }
  }, 180_000);

  afterAll(async () => {
    if (outDir) await rm(outDir, { recursive: true, force: true });
  });

  const catalogCase = (motif: string): CatalogCase => {
    const generatedCase = casesByMotif.get(motif);
    if (!generatedCase) throw new Error(`Catalog case not generated for ${motif}`);
    return generatedCase;
  };

  it.each([
    'formula-chain',
    'lookup-of-formula',
    'lookup-of-select',
    'rollup-manyone',
    'conditional-lookup',
  ])(
    'runs the %s PGlite catalog case with a passing verdict and oracle',
    async (motif) => {
      const generatedCase = catalogCase(motif);
      const report = await runCase({
        teaPath: generatedCase.teaPath,
        manifestPath: generatedCase.manifestPath,
        backendOverride: 'pglite',
        samples: 3,
        warmup: 1,
      });

      expect(report.verdict).toBe('pass');
      expect(report.oracle.status).toBe('pass');
      expect(report.oracle.checks.map((check) => check.kind)).toEqual(
        expect.arrayContaining(['invariant', 'full-recompute'])
      );
    },
    240_000
  );

  it('propagates a parent formula through Orders.ParentValue and Result after flush', async () => {
    const generatedCase = catalogCase('lookup-of-formula');
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(generatedCase.manifestPath, 'utf8')) as unknown
    );
    const loaded = await loadCase({
      teaPath: generatedCase.teaPath,
      manifest,
      backendOverride: 'pglite',
    });

    try {
      const customers = loaded.tables.get('Customers')!;
      const orders = loaded.tables.get('Orders')!;
      const customerRecords = await readTable(loaded, customers);
      const orderRecords = await readTable(loaded, orders);
      expect(customerRecords).toHaveLength(manifest.dataset.rows.Customers);
      expect(orderRecords).toHaveLength(manifest.dataset.rows.Orders);

      for (const customer of customerRecords) {
        expect(numericValue(fieldValue(customer, customers, 'Amount'))).toBe(7);
        expect(numericValue(fieldValue(customer, customers, 'Doubled'))).toBe(14);
      }
      for (const order of orderRecords) {
        expect(lookupValues(fieldValue(order, orders, 'ParentValue'))).toEqual([14]);
        expect(numericValue(fieldValue(order, orders, 'Result'))).toBe(28);
      }

      const beforeParent = lookupValues(fieldValue(orderRecords[0]!, orders, 'ParentValue'));
      const beforeResult = numericValue(fieldValue(orderRecords[0]!, orders, 'Result'));
      const updatedAmount = 100;
      await updateField({
        loaded,
        table: customers,
        fieldName: 'Amount',
        recordIds: customerRecords.map((record) => record.id),
        values: customerRecords.map(() => updatedAmount),
      });
      await loaded.runtime.flushComputed();

      const afterCustomers = await readTable(loaded, customers);
      const afterOrders = await readTable(loaded, orders);
      const expectedDoubled = updatedAmount * 2;
      const expectedResult = expectedDoubled * 2;
      expect(numericValue(fieldValue(afterCustomers[0]!, customers, 'Doubled'))).toBe(
        expectedDoubled
      );
      for (const order of afterOrders) {
        const parentValue = lookupValues(fieldValue(order, orders, 'ParentValue'));
        const result = numericValue(fieldValue(order, orders, 'Result'));
        expect(parentValue).not.toEqual(beforeParent);
        expect(result).not.toBe(beforeResult);
        expect(parentValue).toEqual([expectedDoubled]);
        expect(result).toBe(expectedResult);
      }
    } finally {
      await loaded.close();
    }
  }, 180_000);

  it('recalculates customer rollups after child amounts change and flush', async () => {
    const generatedCase = catalogCase('rollup-manyone');
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(generatedCase.manifestPath, 'utf8')) as unknown
    );
    const loaded = await loadCase({
      teaPath: generatedCase.teaPath,
      manifest,
      backendOverride: 'pglite',
    });

    try {
      const customers = loaded.tables.get('Customers')!;
      const orders = loaded.tables.get('Orders')!;
      const customerRecords = await readTable(loaded, customers);
      const orderRecords = await readTable(loaded, orders);
      expect(customerRecords).toHaveLength(manifest.dataset.rows.Customers);
      expect(orderRecords).toHaveLength(manifest.dataset.rows.Orders);
      expect(orderRecords.length).toBeGreaterThan(1);

      const beforeCustomer = customerRecords[0]!;
      const beforeTotal = numericValue(fieldValue(beforeCustomer, customers, 'Total'));
      const beforeCount = numericValue(fieldValue(beforeCustomer, customers, 'OrderCount'));
      expect(beforeTotal).toBe(orderRecords.length * 7);
      expect(beforeCount).toBe(orderRecords.length);

      const updatedAmounts = orderRecords.map((_, index) => 100 + index);
      await updateField({
        loaded,
        table: orders,
        fieldName: 'Amount',
        recordIds: orderRecords.map((record) => record.id),
        values: updatedAmounts,
      });
      await loaded.runtime.flushComputed();

      const afterCustomer = (await readTable(loaded, customers))[0]!;
      const afterTotal = numericValue(fieldValue(afterCustomer, customers, 'Total'));
      const afterCount = numericValue(fieldValue(afterCustomer, customers, 'OrderCount'));
      expect(afterTotal).not.toBe(beforeTotal);
      expect(afterTotal).toBe(sumNumbers(updatedAmounts));
      expect(afterCount).toBe(beforeCount);
      expect(afterCount).toBe(orderRecords.length);
    } finally {
      await loaded.close();
    }
  }, 180_000);

  it('changes conditional lookup results when parent eligibility crosses the filter', async () => {
    const generatedCase = catalogCase('conditional-lookup');
    const manifest = parseBenchCaseManifest(
      JSON.parse(await readFile(generatedCase.manifestPath, 'utf8')) as unknown
    );
    const loaded = await loadCase({
      teaPath: generatedCase.teaPath,
      manifest,
      backendOverride: 'pglite',
    });

    try {
      const customers = loaded.tables.get('Customers')!;
      const orders = loaded.tables.get('Orders')!;
      const customerRecords = await readTable(loaded, customers);
      const orderRecords = await readTable(loaded, orders);
      expect(customerRecords.length).toBeGreaterThan(0);
      expect(orderRecords.length).toBeGreaterThan(0);
      for (const customer of customerRecords) {
        expect(numericValue(fieldValue(customer, customers, 'Amount'))).toBe(7);
        expect(numericValue(fieldValue(customer, customers, 'Eligible'))).toBe(0);
      }
      for (const order of orderRecords) {
        expect(lookupValues(fieldValue(order, orders, 'EligibleAmounts'))).toEqual([]);
        expect(numericValue(fieldValue(order, orders, 'EligibleTotal'))).toBe(0);
      }

      const customerIds = customerRecords.map((record) => record.id);
      await updateField({
        loaded,
        table: customers,
        fieldName: 'Eligible',
        recordIds: customerIds,
        values: customerIds.map(() => 0),
      });
      await loaded.runtime.flushComputed();
      const excludedOrders = await readTable(loaded, orders);
      for (const order of excludedOrders) {
        expect(lookupValues(fieldValue(order, orders, 'EligibleAmounts'))).toEqual([]);
        expect(numericValue(fieldValue(order, orders, 'EligibleTotal'))).toBe(0);
      }

      const includedAmount = 7;
      await updateField({
        loaded,
        table: customers,
        fieldName: 'Eligible',
        recordIds: customerIds,
        values: customerIds.map(() => 100),
      });
      await loaded.runtime.flushComputed();
      const expectedAmounts = customerRecords.map(() => includedAmount);
      const expectedTotal = sumNumbers(expectedAmounts);
      const includedOrders = await readTable(loaded, orders);
      for (const order of includedOrders) {
        const amounts = lookupValues(fieldValue(order, orders, 'EligibleAmounts'));
        const total = numericValue(fieldValue(order, orders, 'EligibleTotal'));
        expect(amounts).not.toEqual([]);
        expect(total).not.toBe(0);
        expect(amounts).toEqual(expectedAmounts);
        expect(total).toBe(expectedTotal);
      }
    } finally {
      await loaded.close();
    }
  }, 180_000);
});
