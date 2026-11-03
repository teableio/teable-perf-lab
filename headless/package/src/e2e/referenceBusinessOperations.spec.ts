import { readFile } from 'node:fs/promises';

import { parseBenchCaseManifest } from '../case/manifest';
import { runCase } from '../runner/BenchRunner';
import { readTeaArchive } from '../tea/teaZip';

const manifestUrl = new URL(
  '../../fixtures/reference-business-operations/case.manifest.json',
  import.meta.url
);
const teaUrl = new URL('../../fixtures/reference-business-operations/fixture.tea', import.meta.url);

describe('reference business operations case', () => {
  it('loads the generated four-table archive and proves the bounded workflow on PGlite', async () => {
    const manifest = parseBenchCaseManifest(JSON.parse(await readFile(manifestUrl, 'utf8')));
    const archive = readTeaArchive(await readFile(teaUrl));
    const structure = archive.structure as {
      tables: ReadonlyArray<{ name: string; fields: ReadonlyArray<{ name: string }> }>;
    };

    expect(structure.tables.map((table) => table.name)).toEqual([
      'Accounts',
      'Projects',
      'Work Items',
      'Time Entries',
    ]);
    expect(manifest.dataset.rows).toEqual({
      Accounts: 20,
      Projects: 80,
      ['Work Items']: 400,
      ['Time Entries']: 1200,
    });
    expect(manifest.workload.findLast((step) => step.kind.startsWith('write-'))?.kind).toBe(
      'write-delete'
    );

    const report = await runCase({
      teaPath: teaUrl.pathname,
      manifestPath: manifestUrl.pathname,
      backendOverride: 'pglite',
      samples: 1,
      warmup: 0,
    });

    expect(report.verdict).toBe('pass');
    expect(report.correctnessVerdict).toBe('pass');
    expect(report.performanceVerdict).not.toBe('pass');
    const queryObservation = report.operations.find(
      (operation) => operation.key === 'query-project-budget'
    )?.observation;
    expect(queryObservation).toMatchObject({
      recordRelation: 'returned',
      truncated: false,
      fieldNames: expect.arrayContaining(['Title', 'Budget', 'Budget Reserve']),
    });
    expect(queryObservation?.recordIds).toHaveLength(3);
    const updateObservation = report.operations.find(
      (operation) => operation.key === 'restore-account-active'
    )?.observation;
    expect(updateObservation).toMatchObject({
      recordRelation: 'command-target',
      fieldNames: ['Active'],
    });
    expect(updateObservation?.recordIds).toHaveLength(20);
    const flushObservation = report.operations.find(
      (operation) => operation.key === 'flush-after-restore-active'
    )?.observation;
    expect(flushObservation).toEqual({
      recordIds: [],
      recordRelation: 'none',
      fieldNames: [],
      truncated: false,
    });
    expect(report.oracle.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: 'reference/query-project-budget', status: 'pass' }),
        expect.objectContaining({ checkId: 'reference/query-time-cost', status: 'pass' }),
        expect.objectContaining({ checkId: 'reference/update-work-items', status: 'pass' }),
        expect.objectContaining({ checkId: 'reference/clear-membership', status: 'pass' }),
        expect.objectContaining({ checkId: 'reference/restore-membership', status: 'pass' }),
        expect.objectContaining({
          checkId: 'reference/reject-invalid-budget',
          status: 'pass',
          method: 'expected-domain-error-and-unchanged-state',
        }),
        expect.objectContaining({
          checkId: 'reference/pre-delete-full-recompute',
          status: 'pass',
        }),
        expect.objectContaining({ checkId: 'reference/delete-time-entry', status: 'pass' }),
        expect.objectContaining({ checkId: 'reference/final-full-recompute', status: 'pass' }),
      ])
    );
  }, 120_000);
});
