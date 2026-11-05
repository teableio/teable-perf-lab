import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { deriveCases } from '../generator/deriveFromSchema';
import { richDerivedStructure } from '../generator/deriveFromSchema.fixture';
import { runCase } from '../runner/BenchRunner';
import { writeTeaArchive } from '../tea/teaZip';

const temps: string[] = [];

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('derived case propagation', () => {
  it('runs a parent-driven lookup-of-formula case on PGlite', async () => {
    const root = await tempDir('derived-lookup-e2e-');
    const teaPath = join(root, 'rich.tea');
    await writeFile(teaPath, writeTeaArchive(richDerivedStructure));
    const derived = await deriveCases({
      teaPath,
      outDir: join(root, 'cases'),
      limits: { maxRows: 1_000 },
    });
    const manifests = await Promise.all(
      derived.cases.map(async (generated) => ({
        generated,
        manifest: JSON.parse(await readFile(generated.manifestPath, 'utf8')) as {
          dimensions?: Record<string, unknown>;
          workload: ReadonlyArray<{ kind: string; table?: string }>;
        },
      }))
    );
    const lookupOfFormula = manifests.find(
      ({ manifest }) =>
        manifest.dimensions?.backend === 'pglite' &&
        manifest.dimensions?.typecast === false &&
        String(manifest.dimensions?.motif).includes('origin=lookup,depth=2')
    )?.generated;
    if (!lookupOfFormula) throw new Error('No derived PGlite lookup-of-formula case was emitted');

    const report = await runCase({
      teaPath: lookupOfFormula.teaPath,
      manifestPath: lookupOfFormula.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 1,
    });

    expect(report.verdict).toBe('pass');
    expect(report.oracle.status).toBe('pass');
  }, 240_000);
});
