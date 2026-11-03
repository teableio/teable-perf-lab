import { strToU8, zipSync } from 'fflate';

import { readTeaArchive, TEA_ARCHIVE_LIMITS, writeTeaArchive } from './teaZip';

describe('teaZip', () => {
  it('round trips structure and CSV entries', () => {
    const structure = { tables: [{ id: 'tbl1', name: 'Orders' }] };
    const archive = readTeaArchive(
      writeTeaArchive(structure, { 'tables/Orders.csv': 'Name\nA\n' })
    );
    expect(archive.structure).toEqual(structure);
    expect(archive.csvByEntry.get('tables/Orders.csv')).toBe('Name\nA\n');
  });

  it('rejects archives without structure.json', () => {
    try {
      readTeaArchive(zipSync({}));
    } catch (error) {
      expect(error).toMatchObject({ code: 'bench.tea.structure_missing' });
      return;
    }
    throw new Error('expected missing structure rejection');
  });

  it('rejects malformed ZIP bytes before decompression', () => {
    expect(() => readTeaArchive(new Uint8Array([1, 2, 3]))).toThrowError(
      expect.objectContaining({ code: 'bench.tea.archive_invalid' })
    );
  });

  it('rejects encrypted and unsupported compression entries', () => {
    const encrypted = zipSync({ 'structure.json': strToU8('{}') });
    const encryptedView = new DataView(
      encrypted.buffer,
      encrypted.byteOffset,
      encrypted.byteLength
    );
    let centralOffset = -1;
    for (let offset = encrypted.length - 22; offset >= 0; offset -= 1) {
      if (encryptedView.getUint32(offset, true) === 0x06054b50) {
        centralOffset = encryptedView.getUint32(offset + 16, true);
        break;
      }
    }
    if (centralOffset < 0) throw new Error('central directory not found');
    encryptedView.setUint16(centralOffset + 8, 1, true);
    expect(() => readTeaArchive(encrypted)).toThrowError(
      expect.objectContaining({ code: 'bench.tea.encryption_unsupported' })
    );

    const unsupported = zipSync({ 'structure.json': strToU8('{}') });
    const unsupportedView = new DataView(
      unsupported.buffer,
      unsupported.byteOffset,
      unsupported.byteLength
    );
    let unsupportedOffset = -1;
    for (let offset = unsupported.length - 22; offset >= 0; offset -= 1) {
      if (unsupportedView.getUint32(offset, true) === 0x06054b50) {
        unsupportedOffset = unsupportedView.getUint32(offset + 16, true);
        break;
      }
    }
    if (unsupportedOffset < 0) throw new Error('central directory not found');
    unsupportedView.setUint16(unsupportedOffset + 10, 99, true);
    expect(() => readTeaArchive(unsupported)).toThrowError(
      expect.objectContaining({ code: 'bench.tea.compression_unsupported' })
    );
  });

  it('rejects a highly compressed entry before retaining its expanded payload', () => {
    const oversized = strToU8('x'.repeat(TEA_ARCHIVE_LIMITS.maxEntryBytes + 1));
    const archive = zipSync(
      {
        'structure.json': strToU8('{}'),
        'tables/bomb.csv': oversized,
      },
      { level: 9 }
    );
    expect(archive.length).toBeLessThan(oversized.length / 100);
    try {
      readTeaArchive(archive);
    } catch (error) {
      expect(error).toMatchObject({ code: 'bench.tea.resource_limit' });
      return;
    }
    throw new Error('expected expanded entry size rejection');
  });

  it('rejects archives with too many entries', () => {
    const entries: Record<string, Uint8Array> = { 'structure.json': strToU8('{}') };
    for (let index = 0; index < TEA_ARCHIVE_LIMITS.maxEntries; index += 1) {
      entries[`attachments/${index}`] = new Uint8Array();
    }
    try {
      readTeaArchive(zipSync(entries));
    } catch (error) {
      expect(error).toMatchObject({ code: 'bench.tea.resource_limit' });
      return;
    }
    throw new Error('expected archive entry count rejection');
  });
});
