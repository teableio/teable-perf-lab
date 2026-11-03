import { strFromU8, strToU8, Unzip, UnzipInflate, zipSync } from 'fflate';

import { BenchError } from '../errors';

export const TEA_ARCHIVE_LIMITS = {
  maxCompressedBytes: 64 * 1024 * 1024,
  maxEntries: 2_048,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
} as const;

const INPUT_CHUNK_BYTES = 16 * 1024;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP_CENTRAL_SIGNATURE = 0x02014b50;
const ZIP_END_FIXED_BYTES = 22;
const ZIP_MAX_COMMENT_BYTES = 65_535;

const resourceLimit = (message: string, details: unknown): BenchError =>
  new BenchError('bench.tea.resource_limit', message, details);

const archiveInvalid = (message: string, cause?: unknown): BenchError =>
  new BenchError('bench.tea.archive_invalid', message, cause);

type CentralDirectoryHeader = {
  readonly endOffset: number;
  readonly totalEntries: number;
  readonly centralBytes: number;
  readonly centralOffset: number;
};

type CentralEntryMetadata = {
  readonly nextOffset: number;
  readonly originalBytes: number;
};

const readCentralDirectoryHeader = (bytes: Uint8Array, view: DataView): CentralDirectoryHeader => {
  const lowerBound = Math.max(0, bytes.length - ZIP_END_FIXED_BYTES - ZIP_MAX_COMMENT_BYTES);
  for (let offset = bytes.length - ZIP_END_FIXED_BYTES; offset >= lowerBound; offset -= 1) {
    if (
      view.getUint32(offset, true) !== ZIP_END_SIGNATURE ||
      offset + ZIP_END_FIXED_BYTES + view.getUint16(offset + 20, true) !== bytes.length
    ) {
      continue;
    }
    const disk = view.getUint16(offset + 4, true);
    const centralDisk = view.getUint16(offset + 6, true);
    const diskEntries = view.getUint16(offset + 8, true);
    const totalEntries = view.getUint16(offset + 10, true);
    const centralBytes = view.getUint32(offset + 12, true);
    const centralOffset = view.getUint32(offset + 16, true);
    if (
      disk !== 0 ||
      centralDisk !== 0 ||
      diskEntries !== totalEntries ||
      totalEntries === 0xffff ||
      centralBytes === 0xffffffff ||
      centralOffset === 0xffffffff
    ) {
      throw archiveInvalid('Multi-disk and ZIP64 archives are not supported');
    }
    return { endOffset: offset, totalEntries, centralBytes, centralOffset };
  }
  throw archiveInvalid('Archive has no valid ZIP end record');
};

const readCentralEntry = (
  view: DataView,
  offset: number,
  endOffset: number
): CentralEntryMetadata => {
  if (offset + 46 > endOffset || view.getUint32(offset, true) !== ZIP_CENTRAL_SIGNATURE) {
    throw archiveInvalid('Archive central directory entry is invalid');
  }
  const flags = view.getUint16(offset + 8, true);
  const compression = view.getUint16(offset + 10, true);
  const originalBytes = view.getUint32(offset + 24, true);
  const nameBytes = view.getUint16(offset + 28, true);
  const extraBytes = view.getUint16(offset + 30, true);
  const commentBytes = view.getUint16(offset + 32, true);
  if ((flags & 0x0001) !== 0) {
    throw new BenchError(
      'bench.tea.encryption_unsupported',
      'Encrypted archive entries are not supported'
    );
  }
  if (compression !== 0 && compression !== 8) {
    throw new BenchError(
      'bench.tea.compression_unsupported',
      `Archive compression method ${compression} is not supported`
    );
  }
  if (originalBytes === 0xffffffff) {
    throw archiveInvalid('ZIP64 archive entries are not supported');
  }
  return { nextOffset: offset + 46 + nameBytes + extraBytes + commentBytes, originalBytes };
};

const inspectArchiveMetadata = (bytes: Uint8Array): void => {
  if (bytes.length < ZIP_END_FIXED_BYTES) throw archiveInvalid('Archive is not a valid ZIP file');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const { endOffset, totalEntries, centralBytes, centralOffset } = readCentralDirectoryHeader(
    bytes,
    view
  );
  if (totalEntries > TEA_ARCHIVE_LIMITS.maxEntries) {
    throw resourceLimit('Archive contains too many entries', {
      actual: totalEntries,
      limit: TEA_ARCHIVE_LIMITS.maxEntries,
      resource: 'entries',
    });
  }
  if (centralOffset + centralBytes !== endOffset) {
    throw archiveInvalid('Archive central directory is inconsistent');
  }

  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < totalEntries; index += 1) {
    const entry = readCentralEntry(view, offset, endOffset);
    if (entry.originalBytes > TEA_ARCHIVE_LIMITS.maxEntryBytes) {
      throw resourceLimit('Archive entry exceeds the size limit', {
        actual: entry.originalBytes,
        limit: TEA_ARCHIVE_LIMITS.maxEntryBytes,
        resource: 'entryBytes',
      });
    }
    totalBytes += entry.originalBytes;
    if (totalBytes > TEA_ARCHIVE_LIMITS.maxTotalBytes) {
      throw resourceLimit('Archive declared contents exceed the total size limit', {
        actual: totalBytes,
        limit: TEA_ARCHIVE_LIMITS.maxTotalBytes,
        resource: 'totalBytes',
      });
    }
    offset = entry.nextOffset;
  }
  if (offset !== endOffset) throw archiveInvalid('Archive central directory length is invalid');
};

const concatChunks = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
};

export type TeaArchive = {
  readonly structure: unknown;
  readonly csvByEntry: ReadonlyMap<string, string>;
};

export function readTeaArchive(bytes: Uint8Array): TeaArchive {
  if (bytes.length > TEA_ARCHIVE_LIMITS.maxCompressedBytes) {
    throw resourceLimit('Compressed archive exceeds the size limit', {
      actual: bytes.length,
      limit: TEA_ARCHIVE_LIMITS.maxCompressedBytes,
      resource: 'compressedBytes',
    });
  }
  if (bytes.length === 0) {
    throw new BenchError('bench.tea.structure_missing', 'Archive does not contain structure.json');
  }
  inspectArchiveMetadata(bytes);

  const entries = new Map<string, Uint8Array>();
  let entryCount = 0;
  let declaredTotal = 0;
  let actualTotal = 0;
  const unzip = new Unzip((file) => {
    entryCount += 1;
    if (entryCount > TEA_ARCHIVE_LIMITS.maxEntries) {
      file.terminate();
      throw resourceLimit('Archive contains too many entries', {
        actual: entryCount,
        limit: TEA_ARCHIVE_LIMITS.maxEntries,
        resource: 'entries',
      });
    }
    if (file.originalSize !== undefined && file.originalSize > TEA_ARCHIVE_LIMITS.maxEntryBytes) {
      file.terminate();
      throw resourceLimit(`Archive entry ${file.name} exceeds the size limit`, {
        actual: file.originalSize,
        entry: file.name,
        limit: TEA_ARCHIVE_LIMITS.maxEntryBytes,
        resource: 'entryBytes',
      });
    }
    if (file.originalSize !== undefined) {
      declaredTotal += file.originalSize;
      if (declaredTotal > TEA_ARCHIVE_LIMITS.maxTotalBytes) {
        file.terminate();
        throw resourceLimit('Archive declared contents exceed the total size limit', {
          actual: declaredTotal,
          limit: TEA_ARCHIVE_LIMITS.maxTotalBytes,
          resource: 'totalBytes',
        });
      }
    }

    const retain = file.name === 'structure.json' || file.name.endsWith('.csv');
    const chunks: Uint8Array[] = [];
    let entryBytes = 0;
    file.ondata = (error, chunk, final) => {
      if (error) throw archiveInvalid('Archive entry could not be decompressed', error);
      entryBytes += chunk.length;
      actualTotal += chunk.length;
      if (entryBytes > TEA_ARCHIVE_LIMITS.maxEntryBytes) {
        file.terminate();
        throw resourceLimit(`Archive entry ${file.name} exceeds the size limit`, {
          actual: entryBytes,
          entry: file.name,
          limit: TEA_ARCHIVE_LIMITS.maxEntryBytes,
          resource: 'entryBytes',
        });
      }
      if (actualTotal > TEA_ARCHIVE_LIMITS.maxTotalBytes) {
        file.terminate();
        throw resourceLimit('Archive contents exceed the total size limit', {
          actual: actualTotal,
          limit: TEA_ARCHIVE_LIMITS.maxTotalBytes,
          resource: 'totalBytes',
        });
      }
      if (retain && chunk.length > 0) chunks.push(chunk);
      if (retain && final) entries.set(file.name, concatChunks(chunks, entryBytes));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += INPUT_CHUNK_BYTES) {
    const end = Math.min(offset + INPUT_CHUNK_BYTES, bytes.length);
    unzip.push(bytes.subarray(offset, end), end === bytes.length);
  }

  const structureBytes = entries.get('structure.json');
  if (!structureBytes) {
    throw new BenchError('bench.tea.structure_missing', 'Archive does not contain structure.json');
  }
  let structure: unknown;
  try {
    structure = JSON.parse(strFromU8(structureBytes));
  } catch (error) {
    throw new BenchError('bench.tea.structure_invalid', 'structure.json is not valid JSON', error);
  }
  const csvByEntry = new Map<string, string>();
  for (const [name, entry] of entries) {
    if (name.endsWith('.csv')) csvByEntry.set(name, strFromU8(entry));
  }
  return { structure, csvByEntry };
}

export function writeTeaArchive(
  structure: unknown,
  csvByEntry: Readonly<Record<string, string>> = {}
): Uint8Array {
  const entries: Record<string, Uint8Array> = {
    'structure.json': strToU8(JSON.stringify(structure, null, 2)),
  };
  for (const [name, csv] of Object.entries(csvByEntry)) entries[name] = strToU8(csv);
  return zipSync(entries, { level: 0 });
}
