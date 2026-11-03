import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { Console, Effect } from 'effect';

import { BenchError } from '../errors';
import type { BenchCliIo } from './types';

export const defaultIo: BenchCliIo = {
  stdout: (line) => process.stdout.write(`${line}\n`),
  stderr: (line) => process.stderr.write(`${line}\n`),
};

export const jsonLine = (value: unknown): string => JSON.stringify(value);

export const invocationPath = (path: string): string =>
  resolve(process.env.INIT_CWD ?? process.cwd(), path);

/**
 * @effect/cli renders help and parse diagnostics through the Effect Console
 * service. Route help to stdout and suppress framework diagnostics so the CLI
 * emits at most one JSON envelope per failure.
 */
export const benchConsole = (io: BenchCliIo): Console.Console => {
  const base = Effect.runSync(Console.consoleWith(Effect.succeed));
  return {
    ...base,
    error: () => Effect.void,
    log: (...args: ReadonlyArray<unknown>) =>
      Effect.sync(() => io.stdout(args.map(String).join(' '))),
    unsafe: {
      ...base.unsafe,
      error: () => undefined,
      log: (message?: unknown, ...args: ReadonlyArray<unknown>) =>
        io.stdout([message, ...args].map(String).join(' ')),
    },
  };
};

export const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    throw new BenchError('bench.cli.json_invalid', `Could not read JSON from ${path}`, error);
  }
};

export const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};
