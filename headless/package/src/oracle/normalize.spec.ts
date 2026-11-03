import { normalizeRows, normalizeValue } from './normalize';

describe('oracle normalization', () => {
  it('normalizes nested values and sorts arrays without discarding row fields', () => {
    expect(
      normalizeValue({ z: 1.23456789, date: '2024-01-02T03:04:05+00:00', values: [2, 1] })
    ).toEqual({
      date: '2024-01-02T03:04:05.000Z',
      values: [1, 2],
      z: 1.234568,
    });

    expect(
      normalizeRows(
        [
          { Title: 'B', Tax: 2.2222222 },
          { Title: 'A', Tax: 1.1111111 },
        ],
        ['Title']
      )
    ).toEqual([
      { Tax: 1.111111, Title: 'A' },
      { Tax: 2.222222, Title: 'B' },
    ]);
  });

  it('rejects duplicate row identities', () => {
    expect(() => normalizeRows([{ Title: 'A' }, { Title: 'A' }], ['Title'])).toThrow(
      'bench.oracle.duplicate_key'
    );
  });

  it('rejects non-finite numbers instead of normalizing them ambiguously', () => {
    expect(() => normalizeValue(Number.NaN)).toThrow('bench.oracle.number_nonfinite');
    expect(() => normalizeValue(Number.POSITIVE_INFINITY)).toThrow('bench.oracle.number_nonfinite');
  });
});
