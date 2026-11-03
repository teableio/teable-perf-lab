import { execFileSync } from 'node:child_process';

/** Resolve the checked-out benchmark revision without changing provenance precedence. */
export const resolveBenchCommit = (): string => {
  if (process.env.GIT_COMMIT) return process.env.GIT_COMMIT;
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
};
