import { Command } from '@effect/cli';
import { NodeContext } from '@effect/platform-node';
import { Console, Effect, Either } from 'effect';

import { BenchError } from '../errors';

import { buildBenchCommand } from './commands';
import { toErrorEnvelope } from './errors';
import { defaultHandlers } from './handlers';
import { benchConsole, defaultIo, jsonLine } from './io';
import type { BenchCliHandlers, BenchCliIo } from './types';

// pnpm forwards the script separator as a leading literal "--".
const stripScriptSeparator = (argv: ReadonlyArray<string>): ReadonlyArray<string> =>
  argv[0] === '--' ? argv.slice(1) : argv;

/**
 * Runs the benchmark CLI. Effect CLI expects a full process argv (it drops the
 * first two entries) and renders framework diagnostics through the Console
 * service, so both are normalized here before handing off to @effect/cli.
 */
export const runBenchCli = async (
  argv: ReadonlyArray<string> = process.argv.slice(2),
  io: BenchCliIo = defaultIo,
  handlers: BenchCliHandlers = defaultHandlers
): Promise<0 | 1> => {
  const normalizedArgv = stripScriptSeparator(argv);
  if (normalizedArgv.length === 0) {
    io.stderr(
      jsonLine(
        toErrorEnvelope(new BenchError('bench.cli.command_unknown', 'A command is required'))
      )
    );
    return 1;
  }
  let exitCode: 0 | 1 = 0;
  const cli = Command.run(
    buildBenchCommand({
      io,
      handlers,
      setExitCode: (nextExitCode) => {
        exitCode = nextExitCode;
      },
    }),
    { name: 'bench', version: '0.0.0' }
  );
  const program = cli(['bun', 'bench', ...normalizedArgv]).pipe(
    Console.withConsole(benchConsole(io)),
    Effect.provide(NodeContext.layer)
  );
  const result = await Effect.runPromise(Effect.either(program));
  if (Either.isLeft(result)) {
    io.stderr(jsonLine(toErrorEnvelope(result.left)));
    return 1;
  }
  return exitCode;
};
