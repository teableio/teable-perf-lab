import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadDeclaredBusinessTopology } from '../cli/handlers';
import { writeTeaArchive } from '../tea/teaZip';
import { deterministicTestReport } from './fixtures/deterministicReport';
import { deriveDeclaredBusinessTopology } from './topology';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('declared business topology', () => {
  it('derives ownership direction and deduplicates exact directed pairs', () => {
    const topology = deriveDeclaredBusinessTopology({
      tables: [
        {
          id: 'tblProjects',
          name: 'Projects',
          fields: [
            {
              id: 'fldTasks',
              name: 'Tasks',
              type: 'link',
              options: { relationship: 'manyMany', foreignTableId: 'tblTasks' },
            },
          ],
        },
        {
          id: 'tblTasks',
          name: 'Tasks',
          fields: [
            {
              id: 'fldProject',
              name: 'Project',
              type: 'link',
              options: { relationship: 'manyOne', foreignTableId: 'tblProjects' },
            },
            {
              id: 'fldOwner',
              name: 'Owner',
              type: 'link',
              options: { relationship: 'manyOne', foreignTableId: 'tblPeople' },
            },
          ],
        },
        { id: 'tblPeople', name: 'People', fields: [] },
      ],
    });

    expect(topology).toEqual({
      tables: [
        { id: 'tblProjects', name: 'Projects' },
        { id: 'tblTasks', name: 'Tasks' },
        { id: 'tblPeople', name: 'People' },
      ],
      links: [
        { from: 'tblProjects', to: 'tblTasks', label: 'Projects.Tasks → Tasks (manyMany)' },
        { from: 'tblPeople', to: 'tblTasks', label: 'Tasks.Owner → People (manyOne)' },
      ],
    });
  });

  it('keeps declared table and link order without imposing a topological fallback', () => {
    expect(
      deriveDeclaredBusinessTopology({
        tables: [
          {
            id: 'tblB',
            name: 'B',
            fields: [
              {
                name: 'A children',
                type: 'link',
                options: { relationship: 'manyMany', foreignTableId: 'tblA' },
              },
            ],
          },
          {
            id: 'tblA',
            name: 'A',
            fields: [
              {
                name: 'B children',
                type: 'link',
                options: { relationship: 'manyMany', foreignTableId: 'tblB' },
              },
            ],
          },
        ],
      })
    ).toEqual({
      tables: [
        { id: 'tblB', name: 'B' },
        { id: 'tblA', name: 'A' },
      ],
      links: [
        { from: 'tblB', to: 'tblA', label: 'B.A children → A (manyMany)' },
        { from: 'tblA', to: 'tblB', label: 'A.B children → B (manyMany)' },
      ],
    });
  });

  it('returns no topology when the recorded archive is missing', async () => {
    const report = structuredClone(deterministicTestReport);
    report.provenance.reproducibility.inputs = [
      { path: 'definitely-missing/topology-fixture.tea', sha256: '0'.repeat(64) },
    ];

    await expect(loadDeclaredBusinessTopology(report)).resolves.toBeUndefined();
  });

  it('returns no topology when the archive does not match its recorded hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tea-bench-topology-'));
    temporaryDirectories.push(directory);
    const teaPath = join(directory, 'fixture.tea');
    await writeFile(teaPath, writeTeaArchive({ tables: [] }));
    const report = structuredClone(deterministicTestReport);
    report.provenance.reproducibility.inputs = [{ path: teaPath, sha256: '0'.repeat(64) }];

    await expect(loadDeclaredBusinessTopology(report)).resolves.toBeUndefined();
  });
});
