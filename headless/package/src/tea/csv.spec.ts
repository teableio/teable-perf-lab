import { parseCsv } from './csv';

describe('parseCsv', () => {
  it('parses quoted commas', () =>
    expect(parseCsv('Name,Note\nA,"hello, world"')).toEqual({
      header: ['Name', 'Note'],
      rows: [['A', 'hello, world']],
    }));
  it('parses embedded newlines', () =>
    expect(parseCsv('Name,Note\nA,"hello\nworld"').rows[0]).toEqual(['A', 'hello\nworld']));
  it('preserves empty cells', () =>
    expect(parseCsv('A,B,C\n1,,3').rows[0]).toEqual(['1', '', '3']));
  it('rejects malformed quoted input with a BenchError code', () =>
    expect(() => parseCsv('Name,Note\nA,"unterminated')).toThrow(/bench\.csv\.parse_invalid/));

  it('rejects rows wider or narrower than the header', () => {
    expect(() => parseCsv('A,B\n1,2,3')).toThrow(/bench\.csv\.row_width_invalid/);
    expect(() => parseCsv('A,B\n1')).toThrow(/bench\.csv\.row_width_invalid/);
  });

  it('parses a valid single-column CSV', () =>
    expect(parseCsv('Name\nAlice')).toEqual({ header: ['Name'], rows: [['Alice']] }));
});
