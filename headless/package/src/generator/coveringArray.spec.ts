import { describe, expect, it } from 'vitest';

import {
  analyzeCompletablePairs,
  countCompletablePairs,
  generateCoveringArray,
  pairLabel,
  type CoveringDimension,
  type CoveringRow,
} from './coveringArray';

const dimensions: ReadonlyArray<CoveringDimension> = [
  { name: 'A', values: [1, 2, 3] },
  { name: 'B', values: [1, 2] },
  { name: 'C', values: [1, 2, 3] },
];
const constraints = [(row: CoveringRow) => row.A !== 3 || row.B !== 2];

function pairIsCompletable(
  leftName: string,
  leftValue: unknown,
  rightName: string,
  rightValue: unknown
): boolean {
  const row: Record<string, unknown> = {};
  for (const dimension of dimensions) {
    row[dimension.name] = dimension.values[0];
  }
  row[leftName] = leftValue;
  row[rightName] = rightValue;
  return constraints.every((constraint) => constraint(row));
}

function valuePairs(row: CoveringRow): string[] {
  const pairs: string[] = [];
  for (let i = 0; i < dimensions.length; i += 1) {
    for (let j = i + 1; j < dimensions.length; j += 1) {
      const left = dimensions[i]!;
      const right = dimensions[j]!;
      pairs.push(pairLabel(left.name, row[left.name], right.name, row[right.name]));
    }
  }
  return pairs;
}

describe('generateCoveringArray', () => {
  it('covers every completable pair and respects constraints and forced rows', () => {
    const forcedRows = [{ A: 1, B: 2, C: 3 }];
    const result = generateCoveringArray({ dimensions, constraints, forcedRows });

    expect(result.rows).toContainEqual(forcedRows[0]);
    for (const row of result.rows) {
      expect(row.A === 3 && row.B === 2).toBe(false);
    }

    const covered = new Set(result.rows.flatMap(valuePairs));
    for (let i = 0; i < dimensions.length; i += 1) {
      for (let j = i + 1; j < dimensions.length; j += 1) {
        const left = dimensions[i]!;
        const right = dimensions[j]!;
        for (const leftValue of left.values) {
          for (const rightValue of right.values) {
            if (!pairIsCompletable(left.name, leftValue, right.name, rightValue)) continue;
            expect(covered.has(pairLabel(left.name, leftValue, right.name, rightValue))).toBe(true);
          }
        }
      }
    }
    expect(result.uncoveredPairs).toEqual(['A=3|B=2']);
    expect(countCompletablePairs({ dimensions, constraints })).toBe(20);
  });

  it('reports bounded completion as unknown rather than impossible', () => {
    const bounded = generateCoveringArray({
      dimensions,
      constraints,
      maxSearchStates: 1,
      maxMillis: 10_000,
    });
    expect(bounded.receipt.truncated).toBe(true);
    expect(bounded.receipt.truncatedBy).toEqual(['maxSearchStates']);
    expect(bounded.receipt.unknownPairs.length).toBeGreaterThan(0);
    expect(bounded.receipt.nonCompletable).toBe(0);
    expect(bounded.uncoveredPairs).toEqual([]);

    const analysis = analyzeCompletablePairs({
      dimensions,
      constraints,
      maxSearchStates: 1,
      maxMillis: 10_000,
    });
    expect(analysis.count).toBeUndefined();
    expect(() =>
      countCompletablePairs({ dimensions, constraints, maxSearchStates: 1 })
    ).toThrowError(/bench\.generator\.search_truncated/);
  });

  it('uses the exact raw pair formula and conserves classified pairs', () => {
    const result = generateCoveringArray({ dimensions, constraints });
    expect(result.receipt.rawPairCountFormula).toBe('A[3]*B[2] + A[3]*C[3] + B[2]*C[3]');
    expect(result.receipt.rawPairCount).toBe(21);
    expect(
      result.receipt.completable + result.receipt.nonCompletable + result.receipt.unknown
    ).toBe(result.receipt.rawPairCount);
    expect(result.receipt.covered).toBe(result.receipt.completable);
  });

  it('is deterministic for the same input', () => {
    const first = generateCoveringArray({ dimensions, constraints });
    const second = generateCoveringArray({ dimensions, constraints });
    expect(second).toEqual(first);
  });

  it('rejects a forced row that violates constraints', () => {
    expect(() =>
      generateCoveringArray({
        dimensions,
        constraints,
        forcedRows: [{ A: 3, B: 2, C: 1 }],
      })
    ).toThrowError(/bench\.generator\.invalid_forced_row/);
  });

  it('throws when the covering array exceeds maxRows', () => {
    expect(() =>
      generateCoveringArray({
        dimensions,
        constraints,
        maxRows: 1,
      })
    ).toThrowError(/bench\.generator\.too_many_rows/);
  });

  it('rejects forced values outside their declared dimensions', () => {
    expect(() =>
      generateCoveringArray({
        dimensions,
        forcedRows: [{ A: 4, B: 1, C: 1 }],
      })
    ).toThrowError(/bench\.generator\.invalid_forced_row/);
  });

  it('finds pair completions beyond the first values', () => {
    const completionDimensions: ReadonlyArray<CoveringDimension> = [
      { name: 'A', values: [1, 2] },
      { name: 'B', values: [1, 2] },
      { name: 'C', values: [1, 2] },
    ];
    const completionConstraints = [(row: CoveringRow) => row.A !== 2 || row.B !== 2 || row.C === 2];
    const result = generateCoveringArray({
      dimensions: completionDimensions,
      constraints: completionConstraints,
    });
    expect(result.uncoveredPairs).not.toContain('A=2|B=2');
    expect(result.rows).toContainEqual({ A: 2, B: 2, C: 2 });
  });

  it('accepts exactly maxRows when coverage is complete', () => {
    const generated = generateCoveringArray({ dimensions, constraints });
    expect(
      generateCoveringArray({ dimensions, constraints, maxRows: generated.rows.length })
    ).toEqual(generated);
  });
});
