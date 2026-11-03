import { ActorId, ListTableRecordsQuery, type ListTableRecordsResult } from '@teable/v2-core';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { BenchError } from '../errors';

export const MAX_PAGE_SIZE = 1000;

export const unwrapResult = <T>(result: Result<T, unknown>, code: string): T => {
  if (result.isErr()) {
    throw new BenchError(code, String(result.error), result.error);
  }
  return result.value;
};

export const createActorContext = (actorId: string): { actorId: ActorId } => ({
  actorId: unwrapResult(ActorId.create(actorId), 'bench.runtime.actor_invalid'),
});

export const listPage = async (input: {
  runtime: IHeadlessRuntime;
  actorId: string;
  tableId: string;
  limit: number;
  offset: number;
  includeTotal?: boolean;
  projection?: ReadonlyArray<string>;
}): Promise<ListTableRecordsResult> => {
  const query = unwrapResult(
    ListTableRecordsQuery.create({
      tableId: input.tableId,
      fieldKeyType: 'id',
      limit: input.limit,
      offset: input.offset,
      ...(input.includeTotal === undefined ? {} : { includeTotal: input.includeTotal }),
      ...(input.projection ? { projection: [...input.projection] } : {}),
    }),
    'bench.oracle.query_invalid'
  );

  return unwrapResult(
    await input.runtime.queryBus.execute<ListTableRecordsQuery, ListTableRecordsResult>(
      createActorContext(input.actorId),
      query
    ),
    'bench.oracle.query_failed'
  );
};

export const listAllRecords = async (input: {
  runtime: IHeadlessRuntime;
  actorId: string;
  tableId: string;
  projection?: ReadonlyArray<string>;
}): Promise<ReadonlyArray<Record<string, unknown>>> => {
  const records: Array<Record<string, unknown>> = [];
  let offset = 0;

  for (;;) {
    const page = await listPage({
      runtime: input.runtime,
      actorId: input.actorId,
      tableId: input.tableId,
      limit: MAX_PAGE_SIZE,
      offset,
      projection: input.projection,
    });

    if (page.records.length === 0) {
      break;
    }

    for (const record of page.records) {
      records.push({
        id: record.id,
        fields: record.fields as Record<string, unknown>,
      });
    }

    offset += page.records.length;
    if (page.records.length < MAX_PAGE_SIZE) {
      break;
    }
  }

  return records;
};

export const tableRowCount = async (input: {
  runtime: IHeadlessRuntime;
  actorId: string;
  tableId: string;
}): Promise<number> => {
  const page = await listPage({
    runtime: input.runtime,
    actorId: input.actorId,
    tableId: input.tableId,
    limit: 1,
    offset: 0,
    includeTotal: true,
  });
  return page.total;
};
