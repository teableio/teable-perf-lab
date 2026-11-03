import Papa from 'papaparse';

import { BenchError } from '../errors';

export type CsvTable = {
  readonly header: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
};

export function parseCsv(text: string): CsvTable {
  const parsed = Papa.parse<string[]>(text, { delimiter: ',', skipEmptyLines: true });
  if (parsed.errors.length > 0) {
    throw new BenchError(
      'bench.csv.parse_invalid',
      parsed.errors.map((error) => `row ${error.row}: ${error.message}`).join('; '),
      parsed.errors
    );
  }

  const [header, ...rows] = parsed.data;
  if (!header) throw new BenchError('bench.csv.empty', 'CSV has no header row');
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    if (row.length !== header.length) {
      throw new BenchError(
        'bench.csv.row_width_invalid',
        `CSV row ${rowIndex + 2} has ${row.length} cells; expected ${header.length}`,
        { row: rowIndex + 2, expected: header.length, actual: row.length }
      );
    }
  }
  return { header, rows };
}
