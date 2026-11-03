import { describe, expect, it } from 'vitest';

import { CORE_VOLUME_CASES, runCoreVolumeCasesBench } from './runner';
import {
  coreVolumeCaseId,
  CORE_VOLUME_PROFILES,
  deterministicVolumeRow,
  expectedVolumeCounts,
  resolveCoreVolumeProfile,
} from './scenarios';

describe('core volume profiles', () => {
  it('keeps named CI and large profiles at their real row volumes', () => {
    expect(CORE_VOLUME_PROFILES.ci.rowCount).toBe(10_000);
    expect(CORE_VOLUME_PROFILES.large.rowCount).toBe(100_000);
    expect(resolveCoreVolumeProfile()).toEqual({ profile: 'ci', ...CORE_VOLUME_PROFILES.ci });
    expect(resolveCoreVolumeProfile('large')).toEqual({
      profile: 'large',
      ...CORE_VOLUME_PROFILES.large,
    });
    expect(coreVolumeCaseId(CORE_VOLUME_PROFILES.ci)).not.toBe(
      coreVolumeCaseId(CORE_VOLUME_PROFILES.large)
    );
  });

  it('retains actual custom dimensions without relabelling a small run', () => {
    const profile = resolveCoreVolumeProfile({
      rowCount: 12,
      batchSize: 4,
      queryPageSize: 3,
    });
    expect(profile).toEqual({
      profile: 'custom',
      rowCount: 12,
      batchSize: 4,
      queryPageSize: 3,
    });
    expect(coreVolumeCaseId(profile)).toBe('headless-core-volume-cases-v2-12r-4b-3q');
    expect(profile.profile).not.toBe('large');
  });

  it('generates stable rows and exact non-divisible distributions', () => {
    expect(deterministicVolumeRow(0)).toEqual({
      name: 'row-00000000',
      segment: 'update',
      status: 'seed',
      amount: 7,
      guard: 'guard-00-00000000',
    });
    expect(deterministicVolumeRow(1).segment).toBe('delete');
    expect(deterministicVolumeRow(2).segment).toBe('control');
    expect(deterministicVolumeRow(11)).toEqual({
      name: 'row-00000011',
      segment: 'delete',
      status: 'seed',
      amount: 40,
      guard: 'guard-11-00000011',
    });
    expect(expectedVolumeCounts(12)).toEqual({
      update: 2,
      delete: 2,
      control: 8,
      remaining: 10,
    });
  });

  it('rejects profiles that cannot execute every volume operation', () => {
    expect(() => resolveCoreVolumeProfile({ rowCount: 1 })).toThrow(/between 2/);
    expect(() => resolveCoreVolumeProfile({ batchSize: 5_001 })).toThrow(/between 1 and 5000/);
    expect(() => resolveCoreVolumeProfile({ queryPageSize: 1_001 })).toThrow(/between 1 and 1000/);
  });
});

describe('runCoreVolumeCasesBench', () => {
  it('rejects invalid sample configuration', async () => {
    await expect(
      runCoreVolumeCasesBench({ backend: 'pglite', samples: 0, warmup: 0 })
    ).rejects.toThrow(/samples must be a positive integer/);
    await expect(
      runCoreVolumeCasesBench({ backend: 'pglite', samples: 1, warmup: -1 })
    ).rejects.toThrow(/warmup must be a non-negative integer/);
  });

  it('streams, queries, counts, updates, deletes, verifies, and cleans a small PGlite volume', async () => {
    const result = await runCoreVolumeCasesBench({
      backend: 'pglite',
      samples: 2,
      warmup: 1,
      profile: { rowCount: 12, batchSize: 4, queryPageSize: 3 },
    });

    expect(result.errors, JSON.stringify(result.errors, null, 2)).toEqual([]);
    expect(result.correctness).toBe('pass');
    expect(result.caseId).toBe('headless-core-volume-cases-v2-12r-4b-3q');
    expect(result.backend).toBe('pglite');
    expect(result.operations.map(({ key }) => key)).toEqual(
      CORE_VOLUME_CASES.map(({ key }) => key)
    );
    expect(
      result.operations.every(
        ({ count, samplesMs, errors }) =>
          count === 2 &&
          samplesMs.length === 2 &&
          samplesMs.every((sample) => sample >= 0) &&
          errors === 0
      )
    ).toBe(true);
    expect(result.operations[0]).toMatchObject({ rowsWritten: 24 });
    expect(result.operations[1]).toMatchObject({ rowsRead: 4, rowsReturned: 4 });
    expect(result.operations[2]).toMatchObject({ rowsReturned: 2 });
    expect(result.operations[3]).toMatchObject({ rowsWritten: 4 });
    expect(result.operations[4]).toMatchObject({ rowsWritten: 4 });
    expect(result.dimensions).toMatchObject({
      profile: 'custom',
      rowCount: 12,
      batchSize: 4,
      queryPageSize: 3,
      samples: 2,
      warmup: 1,
      selectedUpdateRows: 2,
      selectedDeleteRows: 2,
      controlRows: 8,
      finalRows: 10,
      caseIdentityVersion: 2,
      volumeIdentity: 'headless-core-volume-cases-v2-12r-4b-3q',
      deterministicRecipe: 'indexed-volume-segments-v1',
      creationInput: 'lazy-generator-iterable',
      setupTiming: 'excluded',
      correctnessTiming: 'excluded',
      cleanupTiming: 'excluded',
      excludedCapabilities: ['undo', 'redo', 'realtime'],
      runtimeProvenance: {
        backend: 'pglite',
        backendMode: 'memory://',
        runtimePackage: '@teable/v2-headless-runtime',
      },
    });
  }, 120_000);
});
