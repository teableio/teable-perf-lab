import { ActorId, CreateBaseCommand, type CreateBaseResult } from '@teable/v2-core';
import { createHeadlessRuntime, type IHeadlessRuntime } from '@teable/v2-headless-runtime';
import type { Result } from 'neverthrow';
import { describe, expect, it } from 'vitest';

import { BenchError } from '../errors';
import {
  cleanupBenchBase,
  closeBenchRuntime,
  closeBenchRuntimeAfterError,
  registerBenchBase,
} from './runtimeLifecycle';

const unwrap = <T, E>(result: Result<T, E>): T => {
  if (result.isErr()) throw result.error;
  return result.value;
};

const createPglite = (): Promise<IHeadlessRuntime> =>
  createHeadlessRuntime({ backend: { kind: 'pglite', dataDir: 'memory://' } });

describe('closeBenchRuntime PGlite', () => {
  it('closes the runtime and preserves the original cleanup failure', async () => {
    const runtime = await createPglite();
    const created = unwrap<CreateBaseResult, unknown>(
      await runtime.commandBus.execute(
        { actorId: unwrap(ActorId.create('usr_headless')) },
        unwrap(CreateBaseCommand.create({ name: 'Temporary' }))
      )
    );
    const baseId = created.base.id().toString();
    registerBenchBase(runtime, baseId);
    const original = new BenchError('bench.test.original', 'original failure');

    await expect(closeBenchRuntimeAfterError(runtime, original)).rejects.toBe(original);
    await expect(closeBenchRuntime(runtime)).resolves.toBeUndefined();
  });

  it('does not replace an operation error when cleanup itself fails', async () => {
    const original = new BenchError('bench.test.original', 'original failure');
    const runtime = {
      backend: 'pglite',
      container: { isRegistered: () => false },
      close: async () => {
        throw new Error('cleanup failure');
      },
    } as unknown as IHeadlessRuntime;

    await expect(closeBenchRuntimeAfterError(runtime, original)).rejects.toBe(original);
  });

  it('refuses cleanup for an unowned base', async () => {
    const runtime = await createPglite();
    await expect(cleanupBenchBase(runtime, 'bseunowned00000001')).rejects.toMatchObject({
      code: 'bench.base.not_owned',
    });
    await closeBenchRuntime(runtime);
  });

  it('refuses to register an invalid base id', async () => {
    const runtime = await createPglite();
    expect(() => registerBenchBase(runtime, 'not-a-base')).toThrow(BenchError);
    await closeBenchRuntime(runtime);
  });
});
