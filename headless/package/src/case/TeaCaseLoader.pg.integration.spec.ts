import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { generateCases, type GeneratorSpec } from '../generator/generate';
import { runCase } from '../runner/BenchRunner';
import { freePort, removeContainer, startPostgres } from '../testing/postgresContainer';

const describePg = process.env.TEABLE_V2_RUN_PG_INTEGRATION === '1' ? describe : describe.skip;

describePg('headless benchmark on PostgreSQL', () => {
  it('generates and runs a benchmark case against real PostgreSQL', async () => {
    const port = await freePort();
    const containerName = `teable-headless-bench-${process.pid}-${Date.now()}`;
    const outDir = await mkdtemp(join(tmpdir(), 'teable-headless-bench-pg-'));

    try {
      const { connectionString } = await startPostgres(containerName, port);
      const fixtureUrl = new URL('../../fixtures/smoke.generator.json', import.meta.url);
      const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as GeneratorSpec;
      const generated = await generateCases({ ...fixture, outDir });
      const generatedCase = generated.cases[0];
      if (!generatedCase) throw new Error('Smoke generator did not produce a benchmark case');

      const report = await runCase({
        backendOverride: 'postgres',
        connectionString,
        manifestPath: generatedCase.manifestPath,
        teaPath: generatedCase.teaPath,
        samples: 3,
        warmup: 0,
      });

      expect(report.backend).toBe('postgres');
      expect(report.environment.pgVersion).toContain('PostgreSQL');
      expect(report.verdict).toBe('pass');
      expect(report.repetitions[0]?.setup.totalRows).toBeGreaterThan(0);
    } finally {
      await removeContainer(containerName);
      await rm(outDir, { recursive: true, force: true });
    }
  }, 240_000);
});
