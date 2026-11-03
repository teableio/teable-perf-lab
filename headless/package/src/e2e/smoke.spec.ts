import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fixture from '../../fixtures/smoke.generator.json' with { type: 'json' };

import { generateCases, type GeneratorSpec } from '../generator/generate';
import { runCase } from '../runner/BenchRunner';

describe('headless bench smoke', () => {
  it('runs the first generated PGlite case', async () => {
    const spec = fixture as unknown as GeneratorSpec;
    const outDir = await mkdtemp(join(tmpdir(), 'headless-bench-smoke-'));
    const generated = await generateCases({ ...spec, outDir });
    const first = generated.cases[0];
    expect(first).toBeDefined();

    const report = await runCase({
      teaPath: first!.teaPath,
      manifestPath: first!.manifestPath,
      backendOverride: 'pglite',
      samples: 3,
      warmup: 1,
    });

    expect(report.verdict).toBe('pass');
    expect(report.operations.length).toBeGreaterThanOrEqual(3);
  });
});
