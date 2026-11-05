import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const POSTGRES_IMAGE = 'postgres:16-alpine';
const DATABASE = 'teable_headless_bench';
const READY_TIMEOUT_MS = 90_000;

const execFileAsync = promisify(execFile);

export const freePort = async (): Promise<number> => {
  const server = createServer();
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address();
  if (!address || typeof address === 'string') {
    const closed = Promise.withResolvers<void>();
    server.close(() => closed.resolve());
    await closed.promise;
    throw new Error('Could not allocate a loopback port for PostgreSQL');
  }
  const { port } = address;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
};

export const startPostgres = async (
  name: string,
  port: number
): Promise<{ connectionString: string }> => {
  await execFileAsync('docker', [
    'run',
    '--detach',
    '--name',
    name,
    '--publish',
    `127.0.0.1:${port}:5432`,
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env',
    `POSTGRES_DB=${DATABASE}`,
    POSTGRES_IMAGE,
  ]);

  // `pg_isready` can pass during the restart window right after initdb; a real
  // client connection is the only proof the server accepts queries.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      await execFileAsync('docker', [
        'exec',
        name,
        'psql',
        '-U',
        'postgres',
        '-d',
        DATABASE,
        '-Atc',
        'select 1',
      ]);
      return { connectionString: `postgres://postgres@127.0.0.1:${port}/${DATABASE}` };
    } catch {
      await delay(250);
    }
  }
  throw new Error(`PostgreSQL container ${name} did not become ready within ${READY_TIMEOUT_MS}ms`);
};

export const removeContainer = async (name: string): Promise<void> => {
  try {
    await execFileAsync('docker', ['rm', '--force', name]);
  } catch {
    // The container may never have been created; nothing left to clean up.
  }
};
