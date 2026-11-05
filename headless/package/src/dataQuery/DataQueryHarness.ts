import { v2DataDbTokens } from '@teable/v2-adapter-db-postgres-shared';
import { PostgresDataQueryExecutor } from '@teable/v2-adapter-table-repository-postgres';
import {
  ActorId,
  NoopLogger,
  RecordQueryPluginRunner,
  type ITableRepository,
  v2CoreTokens,
} from '@teable/v2-core';
import { DataQueryDefinition, DataQueryService, type DataQueryResult } from '@teable/v2-data-query';
import type { IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';

import { BenchError } from '../errors';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

export type DataQueryHarness = {
  execute(
    definition: unknown,
    parameters?: Readonly<Record<string, unknown>>
  ): Promise<DataQueryResult>;
};

export function createDataQueryHarness(input: {
  runtime: IHeadlessRuntime;
  actorId: string;
}): DataQueryHarness {
  const tableRepository = input.runtime.container.resolve<ITableRepository>(
    v2CoreTokens.tableRepository
  );
  const recordQueryPluginRunner = input.runtime.container.isRegistered(
    v2CoreTokens.recordQueryPluginRunner
  )
    ? input.runtime.container.resolve<RecordQueryPluginRunner>(v2CoreTokens.recordQueryPluginRunner)
    : new RecordQueryPluginRunner([], new NoopLogger());
  type DataQueryDb = ConstructorParameters<typeof PostgresDataQueryExecutor>[0];
  const db = input.runtime.container.resolve<DataQueryDb>(v2DataDbTokens.db);
  const executor = new PostgresDataQueryExecutor(db);
  const service = new DataQueryService(tableRepository, recordQueryPluginRunner, executor);
  const context = { actorId: unwrap(ActorId.create(input.actorId)) };

  return {
    async execute(definition, parameters) {
      const parsed = DataQueryDefinition.create(definition);
      if (parsed.isErr()) {
        throw new BenchError(
          'bench.data_query.definition_invalid',
          parsed.error.message,
          parsed.error.details
        );
      }

      const result = await service.execute(context, parsed.value, { parameters: parameters ?? {} });
      if (result.isErr()) {
        throw new BenchError(
          'bench.data_query.execute_failed',
          result.error.message,
          result.error.details
        );
      }
      return result.value;
    },
  };
}
