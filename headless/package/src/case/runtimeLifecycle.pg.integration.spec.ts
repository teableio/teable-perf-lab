import { v2DataDbTokens } from '@teable/v2-adapter-db-postgres-shared';
import type { Kysely } from 'kysely';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';

import { writeTeaArchive } from '../tea/teaZip';
import { freePort, removeContainer, startPostgres } from '../testing/postgresContainer';
import { createBaseAndImport, createRuntimeForBackend } from './loadSteps';
import { closeBenchRuntime } from './runtimeLifecycle';

const describePg = process.env.TEABLE_V2_RUN_PG_INTEGRATION === '1' ? describe : describe.skip;
const SENTINEL = 'bsesentinel00000001';

const fixtureTea = (): Uint8Array =>
  writeTeaArchive({
    tables: [
      {
        id: 'tblcustomers0000001',
        name: 'Customers',
        fields: [
          {
            id: 'fldcustomersname001',
            name: 'Name',
            type: 'singleLineText',
            isPrimary: true,
          },
        ],
        views: [{ type: 'grid', name: 'Grid' }],
      },
    ],
  });

describePg('PostgreSQL benchmark runtime lifecycle', () => {
  it('removes successful and failed run bases and releases pools', async () => {
    const port = await freePort();
    const containerName = `teable-headless-bench-life-${process.pid}-${Date.now()}`;
    const { connectionString } = await startPostgres(containerName, port);

    try {
      const setup = await createRuntimeForBackend({ backend: 'postgres', connectionString });
      const setupDb = setup.container.resolve<Kysely<unknown>>(v2DataDbTokens.db);
      await sql`
        insert into public.base (id, space_id, name, "order", created_by)
        values (${SENTINEL}, 'spc00000000000000000', 'sentinel', 0, 'sentinel')
        on conflict (id) do nothing
      `.execute(setupDb);
      await setupDb.schema.createSchema(SENTINEL).ifNotExists().execute();
      await setupDb.schema
        .withSchema(SENTINEL)
        .createTable('kept')
        .ifNotExists()
        .addColumn('id', 'integer')
        .execute();
      await sql`
        insert into public.computed_update_outbox
          (id, base_id, seed_table_id, change_type, status, plan_hash, run_id)
        values ('sentinel-task', ${SENTINEL}, 'tblsentinel00000001', 'create', 'pending', 'sentinel', 'sentinel')
        on conflict (id) do nothing
      `.execute(setupDb);
      const attachmentId = 'act_shared_bench_lifecycle';
      const attachmentToken = 'tok_shared_bench_lifecycle';
      await sql`
        insert into public.attachments
          (id, token, hash, size, mimetype, path, created_by)
        values (
          ${attachmentId}, ${attachmentToken}, 'shared-bench-lifecycle', 1,
          'text/plain', 'sha256/shared-bench-lifecycle', 'usr_headless'
        )
      `.execute(setupDb);
      await sql`
        insert into public.attachments_table
          (id, attachment_id, token, name, table_id, record_id, field_id, created_by)
        values ('atr_sentinel_shared', ${attachmentId}, ${attachmentToken}, 'shared.txt',
          'tblsentinel00000001', 'recsentinel00000001', 'fldsentinel00000001', 'usr_headless')
      `.execute(setupDb);
      await closeBenchRuntime(setup);

      const created: string[] = [];
      for (const name of ['first', 'second']) {
        const runtime = await createRuntimeForBackend({ backend: 'postgres', connectionString });
        try {
          const imported = await createBaseAndImport({
            runtime,
            baseName: name,
            teaBytes: fixtureTea(),
            actorId: 'usr_headless',
          });
          created.push(imported.baseId);
          const tableId = imported.tables[0]!.id().toString();
          await sql`
            insert into public.attachments_table
              (id, attachment_id, token, name, table_id, record_id, field_id, created_by)
            values (${`atr_owned_shared_${name}`}, ${attachmentId}, ${attachmentToken}, 'shared.txt',
              ${tableId}, ${`recowned_${name}`}, ${`fldowned_${name}`}, 'usr_headless')
          `.execute(runtime.container.resolve<Kysely<unknown>>(v2DataDbTokens.db));
        } finally {
          await closeBenchRuntime(runtime);
          await closeBenchRuntime(runtime);
        }
      }

      const failed = await createRuntimeForBackend({ backend: 'postgres', connectionString });
      const failedDb = failed.container.resolve<Kysely<unknown>>(v2DataDbTokens.db);
      let caught: unknown;
      try {
        try {
          await createBaseAndImport({
            runtime: failed,
            baseName: 'partial-import',
            teaBytes: new Uint8Array([1, 2, 3]),
            actorId: 'usr_headless',
          });
        } catch (error) {
          const remaining = await sql<{ id: string }>`
            select id from public.base where name = 'partial-import'
          `.execute(failedDb);
          if (remaining.rows[0]?.id) created.push(remaining.rows[0].id);
          caught = error;
        }
      } finally {
        await closeBenchRuntime(failed);
      }
      expect(caught).toBeInstanceOf(Error);

      const observer = await createRuntimeForBackend({ backend: 'postgres', connectionString });
      try {
        const db = observer.container.resolve<Kysely<unknown>>(v2DataDbTokens.db);
        const schemaRows = await sql<{ nspname: string }>`
          select nspname from pg_namespace where nspname like 'bse%'
        `.execute(db);
        expect(schemaRows.rows.map((row) => row.nspname)).toEqual([SENTINEL]);
        const benchmarkBases = await sql<{ baseCount: string; outboxCount: string }>`
          select
            (select count(*)::text from public.base where id <> ${SENTINEL} and id like 'bse%') as "baseCount",
            (select count(*)::text from public.computed_update_outbox where base_id <> ${SENTINEL} and base_id like 'bse%') as "outboxCount"
        `.execute(db);
        expect(benchmarkBases.rows[0]).toEqual({ baseCount: '0', outboxCount: '0' });
        for (const baseId of created) {
          const tableMeta = await sql<{ count: string }>`
            select count(*)::text as count from public.table_meta where base_id = ${baseId}
          `.execute(db);
          const outbox = await sql<{ count: string }>`
            select count(*)::text as count from public.computed_update_outbox where base_id = ${baseId}
          `.execute(db);
          expect(Number(tableMeta.rows[0]?.count ?? 0)).toBe(0);
          expect(Number(outbox.rows[0]?.count ?? 0)).toBe(0);
        }
        const sentinel = await sql<{ baseCount: string; outboxCount: string }>`
          select
            (select count(*)::text from public.base where id = ${SENTINEL}) as "baseCount",
            (select count(*)::text from public.computed_update_outbox where base_id = ${SENTINEL}) as "outboxCount"
        `.execute(db);
        expect(sentinel.rows[0]).toEqual({ baseCount: '1', outboxCount: '1' });
        const sharedAttachment = await sql<{ count: string }>`
          select count(*)::text as count from public.attachments where id = 'act_shared_bench_lifecycle'
        `.execute(db);
        const survivingReference = await sql<{ count: string }>`
          select count(*)::text as count from public.attachments_table
          where id = 'atr_sentinel_shared' and attachment_id = 'act_shared_bench_lifecycle'
        `.execute(db);
        expect(sharedAttachment.rows[0]?.count).toBe('1');
        expect(survivingReference.rows[0]?.count).toBe('1');
        const connections = await sql<{ count: string }>`
          select count(*)::text as count
          from pg_stat_activity
          where datname = current_database()
            and pid <> pg_backend_pid()
            and application_name <> 'pg_isready'
        `.execute(db);
        expect(Number(connections.rows[0]?.count ?? 0)).toBe(0);
      } finally {
        await closeBenchRuntime(observer);
      }
    } finally {
      await removeContainer(containerName);
    }
  }, 240_000);
});
