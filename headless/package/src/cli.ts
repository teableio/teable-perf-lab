import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { runBenchCli } from './cli/run';

export { runBenchCli } from './cli/run';
export type { BenchCliIo } from './cli/types';

const invokedPath =
  process.argv[1] === undefined ? undefined : pathToFileURL(resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
  void runBenchCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
