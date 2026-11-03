import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { generateObservedSmoke } from './observedSmoke';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true }))
  );
});

describe('observed smoke private output boundary', () => {
  it('requires an explicit output directory outside the checkout', async () => {
    await expect(generateObservedSmoke('')).rejects.toThrow(
      'An explicit private output directory is required'
    );
    await expect(generateObservedSmoke(packageRoot)).rejects.toThrow(
      'Observed smoke output must be outside the source checkout'
    );
  });

  it('resolves symlinks before enforcing the checkout boundary', async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'observed-smoke-output-'));
    temporaryDirectories.push(temporary);
    const disguisedCheckout = join(temporary, 'private-output');
    await symlink(packageRoot, disguisedCheckout, 'dir');

    await expect(generateObservedSmoke(disguisedCheckout)).rejects.toThrow(
      'Observed smoke output must be outside the source checkout'
    );
  });
});
