import {
  ActorId,
  CreateBaseCommand,
  CreateRecordCommand,
  CreateTableCommand,
  type CreateBaseResult,
  type CreateRecordResult,
  type CreateTableResult,
} from '@teable/v2-core';
import { createHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';
import { afterEach, describe, expect, it } from 'vitest';

import { createDataQueryHarness } from './DataQueryHarness';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

describe('DataQueryHarness', () => {
  const runtimes: Array<{ close(): Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  });

  it('filters records and joins a many-one relation on PGlite', async () => {
    const runtime = await createHeadlessRuntime({
      backend: { kind: 'pglite', dataDir: 'memory://' },
    });
    runtimes.push(runtime);
    const actorId = unwrap(ActorId.create('usr_headless'));
    const context = { actorId };
    const base = unwrap(
      await runtime.commandBus.execute<CreateBaseCommand, CreateBaseResult>(
        context,
        unwrap(CreateBaseCommand.create({ name: 'Query harness' }))
      )
    );
    const baseId = base.base.id().toString();
    const customers = unwrap(
      await runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
        context,
        unwrap(
          CreateTableCommand.create({
            baseId,
            name: 'Customers',
            fields: [
              { id: 'fldCustomerName', name: 'Name', type: 'singleLineText', isPrimary: true },
            ],
          })
        )
      )
    );
    const customersId = customers.table.id().toString();
    const customerNames = ['Acme', 'Beta', 'Gamma'];
    const customerIds: string[] = [];
    for (const name of customerNames) {
      const created = unwrap(
        await runtime.commandBus.execute<CreateRecordCommand, CreateRecordResult>(
          context,
          unwrap(
            CreateRecordCommand.create({
              tableId: customersId,
              fieldKeyType: 'id',
              fields: { fldCustomerName: name },
            })
          )
        )
      );
      customerIds.push(created.record.id().toString());
    }

    const orders = unwrap(
      await runtime.commandBus.execute<CreateTableCommand, CreateTableResult>(
        context,
        unwrap(
          CreateTableCommand.create({
            baseId,
            name: 'Orders',
            fields: [
              { id: 'fldOrderTitle', name: 'Title', type: 'singleLineText', isPrimary: true },
              { id: 'fldAmount', name: 'Amount', type: 'number' },
              {
                id: 'fldCustomer',
                name: 'Customer',
                type: 'link',
                options: {
                  relationship: 'manyOne',
                  foreignTableId: customersId,
                  lookupFieldId: 'fldCustomerName',
                  isOneWay: true,
                },
              },
            ],
          })
        )
      )
    );
    const ordersId = orders.table.id().toString();
    const amounts = [10, 20, 30];
    for (const [index, amount] of amounts.entries()) {
      unwrap(
        await runtime.commandBus.execute<CreateRecordCommand, CreateRecordResult>(
          context,
          unwrap(
            CreateRecordCommand.create({
              tableId: ordersId,
              fieldKeyType: 'id',
              fields: {
                fldOrderTitle: `Order ${index + 1}`,
                fldAmount: amount,
                fldCustomer: { id: customerIds[index], title: customerNames[index] },
              },
            })
          )
        )
      );
    }
    await runtime.flushComputed();

    const harness = createDataQueryHarness({ runtime, actorId: 'usr_headless' });
    const filtered = await harness.execute({
      version: 1,
      kind: 'records',
      tableId: ordersId,
      filter: { fieldId: 'fldAmount', operator: 'isGreater', value: 10 },
      page: { limit: 10 },
      select: [{ fieldId: 'fldAmount', alias: 'amount' }],
    });
    expect(
      filtered.rows.map((row) => row.amount).sort((left, right) => Number(left) - Number(right))
    ).toEqual([20, 30]);
    expect(filtered.rows).toHaveLength(2);

    const related = await harness.execute({
      version: 2,
      kind: 'records',
      tableId: ordersId,
      relations: { customer: { linkFieldId: 'fldCustomer', tableId: customersId } },
      page: { limit: 10 },
      select: [
        { fieldId: 'fldAmount', alias: 'amount' },
        { source: 'customer', fieldId: 'fldCustomerName', alias: 'customerName' },
      ],
    });
    expect(related.rows).toHaveLength(3);
    expect(related.rows).toEqual(
      expect.arrayContaining([
        { amount: 10, customerName: 'Acme' },
        { amount: 20, customerName: 'Beta' },
        { amount: 30, customerName: 'Gamma' },
      ])
    );
  }, 120_000);
});
