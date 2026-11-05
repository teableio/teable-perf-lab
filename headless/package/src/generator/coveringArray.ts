import { canonicalJson } from '../case/canonicalJson';
import { BenchError } from '../errors';

export type CoveringDimension = {
  readonly name: string;
  readonly values: ReadonlyArray<unknown>;
};

export type CoveringRow = Readonly<Record<string, unknown>>;

type Constraint = (row: CoveringRow) => boolean;

type Pair = {
  readonly a: string;
  readonly aValue: unknown;
  readonly b: string;
  readonly bValue: unknown;
};

type PairWithWitness = Pair & { readonly witness: CoveringRow };

export type SearchTruncation = 'maxSearchStates' | 'maxMillis';
export type PairSearchReceipt = {
  readonly rawPairCountFormula: string;
  readonly rawPairCount: number;
  readonly completable: number;
  readonly nonCompletable: number;
  readonly unknown: number;
  readonly searchStates: number;
  readonly truncated: boolean;
  readonly truncatedBy: ReadonlyArray<SearchTruncation>;
  readonly unknownPairs: ReadonlyArray<string>;
  readonly bounds: { readonly maxSearchStates: number; readonly maxMillis: number };
};

export type CompletablePairAnalysis = {
  readonly count?: number;
  readonly nonCompletablePairs: ReadonlyArray<string>;
  readonly receipt: PairSearchReceipt;
};

export type CoveringArrayResult = {
  readonly rows: ReadonlyArray<CoveringRow>;
  /** Proven impossible pairs followed by completable pairs not covered by emitted rows. */
  readonly uncoveredPairs: ReadonlyArray<string>;
  readonly receipt: PairSearchReceipt & { readonly covered: number };
};

type SearchBudget = {
  readonly startedAt: number;
  readonly maxSearchStates: number;
  readonly maxMillis: number;
  searchStates: number;
  readonly truncatedBy: Set<SearchTruncation>;
};

type Completion =
  | { readonly state: 'satisfiable'; readonly row: CoveringRow }
  | { readonly state: 'unsatisfiable' }
  | { readonly state: 'unknown' };

const DEFAULT_MAX_SEARCH_STATES = 100_000;
const DEFAULT_MAX_MILLIS = 5_000;

function literalKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value);
  }
  return canonicalJson(value);
}

function valueEquals(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function pairKey(pair: Pair): string {
  return canonicalJson([pair.a, pair.aValue, pair.b, pair.bValue]);
}

export function pairLabel(
  leftName: string,
  leftValue: unknown,
  rightName: string,
  rightValue: unknown
): string {
  return `${leftName}=${literalKey(leftValue)}|${rightName}=${literalKey(rightValue)}`;
}

function validateBound(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new BenchError('bench.generator.limit_invalid', `${name} must be a positive integer`, {
      [name]: value,
    });
  }
}

function makeBudget(input: { maxSearchStates?: number; maxMillis?: number }): SearchBudget {
  const maxSearchStates = input.maxSearchStates ?? DEFAULT_MAX_SEARCH_STATES;
  const maxMillis = input.maxMillis ?? DEFAULT_MAX_MILLIS;
  validateBound('maxSearchStates', maxSearchStates);
  validateBound('maxMillis', maxMillis);
  return {
    startedAt: Date.now(),
    maxSearchStates,
    maxMillis,
    searchStates: 0,
    truncatedBy: new Set<SearchTruncation>(),
  };
}

function budgetAvailable(budget: SearchBudget): boolean {
  if (budget.searchStates >= budget.maxSearchStates) {
    budget.truncatedBy.add('maxSearchStates');
    return false;
  }
  if (Date.now() - budget.startedAt >= budget.maxMillis) {
    budget.truncatedBy.add('maxMillis');
    return false;
  }
  return true;
}

/** Deterministic depth-first completion with one budget shared by the whole analysis. */
function findCompletion(input: {
  dimensions: ReadonlyArray<CoveringDimension>;
  constraints: ReadonlyArray<Constraint>;
  partial: Readonly<Record<string, unknown>>;
  budget: SearchBudget;
}): Completion {
  const row: Record<string, unknown> = { ...input.partial };
  const visit = (index: number): Completion => {
    if (!budgetAvailable(input.budget)) return { state: 'unknown' };
    input.budget.searchStates += 1;
    if (index === input.dimensions.length) {
      return input.constraints.every((constraint) => constraint(row))
        ? { state: 'satisfiable', row: { ...row } }
        : { state: 'unsatisfiable' };
    }
    const dimension = input.dimensions[index]!;
    if (dimension.name in row) return visit(index + 1);
    let sawUnknown = false;
    for (const value of dimension.values) {
      row[dimension.name] = value;
      const result = visit(index + 1);
      if (result.state === 'satisfiable') return result;
      if (result.state === 'unknown') sawUnknown = true;
    }
    delete row[dimension.name];
    return sawUnknown ? { state: 'unknown' } : { state: 'unsatisfiable' };
  };
  return visit(0);
}

function rawPairCount(dimensions: ReadonlyArray<CoveringDimension>): number {
  let total = 0;
  for (let left = 0; left < dimensions.length; left += 1) {
    for (let right = left + 1; right < dimensions.length; right += 1) {
      total += dimensions[left]!.values.length * dimensions[right]!.values.length;
    }
  }
  return total;
}

function rawPairCountFormula(dimensions: ReadonlyArray<CoveringDimension>): string {
  const terms: string[] = [];
  for (let left = 0; left < dimensions.length; left += 1) {
    for (let right = left + 1; right < dimensions.length; right += 1) {
      terms.push(
        `${dimensions[left]!.name}[${dimensions[left]!.values.length}]*${dimensions[right]!.name}[${dimensions[right]!.values.length}]`
      );
    }
  }
  return terms.length === 0 ? '0' : terms.join(' + ');
}

function pairsFor(input: {
  dimensions: ReadonlyArray<CoveringDimension>;
  constraints: ReadonlyArray<Constraint>;
  budget: SearchBudget;
}): {
  pairs: ReadonlyArray<PairWithWitness>;
  nonCompletable: ReadonlyArray<string>;
  unknown: ReadonlyArray<string>;
} {
  const pairs: PairWithWitness[] = [];
  const nonCompletable: string[] = [];
  const unknown: string[] = [];
  for (let leftIndex = 0; leftIndex < input.dimensions.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < input.dimensions.length; rightIndex += 1) {
      const left = input.dimensions[leftIndex]!;
      const right = input.dimensions[rightIndex]!;
      for (const leftValue of left.values) {
        for (const rightValue of right.values) {
          const label = pairLabel(left.name, leftValue, right.name, rightValue);
          if (input.constraints.length === 0) {
            const witness: Record<string, unknown> = {};
            for (const dimension of input.dimensions) witness[dimension.name] = dimension.values[0];
            witness[left.name] = leftValue;
            witness[right.name] = rightValue;
            pairs.push({
              a: left.name,
              aValue: leftValue,
              b: right.name,
              bValue: rightValue,
              witness,
            });
            continue;
          }
          const completion = findCompletion({
            ...input,
            partial: { [left.name]: leftValue, [right.name]: rightValue },
          });
          if (completion.state === 'satisfiable') {
            pairs.push({
              a: left.name,
              aValue: leftValue,
              b: right.name,
              bValue: rightValue,
              witness: completion.row,
            });
          } else if (completion.state === 'unsatisfiable') nonCompletable.push(label);
          else unknown.push(label);
        }
      }
    }
  }
  return { pairs, nonCompletable, unknown };
}

function receiptFor(input: {
  dimensions: ReadonlyArray<CoveringDimension>;
  pairs: ReadonlyArray<PairWithWitness>;
  nonCompletable: ReadonlyArray<string>;
  unknown: ReadonlyArray<string>;
  budget: SearchBudget;
}): PairSearchReceipt {
  return {
    rawPairCountFormula: rawPairCountFormula(input.dimensions),
    rawPairCount: rawPairCount(input.dimensions),
    completable: input.pairs.length,
    nonCompletable: input.nonCompletable.length,
    unknown: input.unknown.length,
    searchStates: input.budget.searchStates,
    truncated: input.unknown.length > 0,
    truncatedBy: [...input.budget.truncatedBy],
    unknownPairs: input.unknown,
    bounds: {
      maxSearchStates: input.budget.maxSearchStates,
      maxMillis: input.budget.maxMillis,
    },
  };
}

export function analyzeCompletablePairs(input: {
  dimensions: ReadonlyArray<CoveringDimension>;
  constraints?: ReadonlyArray<Constraint>;
  maxSearchStates?: number;
  maxMillis?: number;
}): CompletablePairAnalysis {
  const budget = makeBudget(input);
  const result = pairsFor({
    dimensions: input.dimensions,
    constraints: input.constraints ?? [],
    budget,
  });
  const receipt = receiptFor({ dimensions: input.dimensions, ...result, budget });
  return {
    ...(receipt.truncated ? {} : { count: result.pairs.length }),
    nonCompletablePairs: result.nonCompletable,
    receipt,
  };
}

/** Returns an exact count; use analyzeCompletablePairs when truncation is an acceptable outcome. */
export function countCompletablePairs(input: {
  dimensions: ReadonlyArray<CoveringDimension>;
  constraints?: ReadonlyArray<Constraint>;
  maxSearchStates?: number;
  maxMillis?: number;
}): number {
  const analysis = analyzeCompletablePairs(input);
  if (analysis.count === undefined) {
    throw new BenchError(
      'bench.generator.search_truncated',
      'completable pair count is unknown because the bounded search was truncated',
      analysis.receipt
    );
  }
  return analysis.count;
}

export function generateCoveringArray(input: {
  dimensions: ReadonlyArray<CoveringDimension>;
  constraints?: ReadonlyArray<Constraint>;
  forcedRows?: ReadonlyArray<CoveringRow>;
  maxRows?: number;
  maxSearchStates?: number;
  maxMillis?: number;
}): CoveringArrayResult {
  const constraints = input.constraints ?? [];
  const forcedRows = input.forcedRows ?? [];
  const satisfies = (row: CoveringRow): boolean =>
    constraints.every((constraint) => constraint(row));

  for (const forced of forcedRows) {
    const missing = input.dimensions.find((dimension) => !(dimension.name in forced));
    if (missing) {
      throw new BenchError(
        'bench.generator.invalid_forced_row',
        'forced row is missing a dimension',
        { dimension: missing.name, row: forced }
      );
    }
    const invalidValue = input.dimensions.find(
      (dimension) => !dimension.values.some((value) => valueEquals(value, forced[dimension.name]))
    );
    if (invalidValue) {
      throw new BenchError(
        'bench.generator.invalid_forced_row',
        'forced row contains a value outside its dimension',
        { dimension: invalidValue.name, value: forced[invalidValue.name], row: forced }
      );
    }
    if (!satisfies(forced)) {
      throw new BenchError(
        'bench.generator.invalid_forced_row',
        'forced row violates constraints',
        {
          row: forced,
        }
      );
    }
  }
  if (input.maxRows !== undefined && forcedRows.length > input.maxRows) {
    throw new BenchError('bench.generator.too_many_rows', 'forced rows exceed max rows', {
      maxRows: input.maxRows,
      rows: forcedRows.length,
    });
  }

  const budget = makeBudget(input);
  if (input.dimensions.length <= 1) {
    const rows: CoveringRow[] = [...forcedRows];
    for (const value of input.dimensions[0]?.values ?? []) {
      const candidate = { [input.dimensions[0]!.name]: value };
      if (!satisfies(candidate)) continue;
      if (!rows.some((existing) => canonicalJson(existing) === canonicalJson(candidate))) {
        if (input.maxRows !== undefined && rows.length >= input.maxRows) {
          throw new BenchError('bench.generator.too_many_rows', 'covering array exceeds max rows', {
            maxRows: input.maxRows,
            rows: rows.length + 1,
          });
        }
        rows.push(candidate);
      }
    }
    const receipt = receiptFor({
      dimensions: input.dimensions,
      pairs: [],
      nonCompletable: [],
      unknown: [],
      budget,
    });
    return { rows, uncoveredPairs: [], receipt: { ...receipt, covered: 0 } };
  }

  const classified = pairsFor({ dimensions: input.dimensions, constraints, budget });
  const uncovered = new Map<string, PairWithWitness>(
    classified.pairs.map((pair) => [pairKey(pair), pair])
  );
  const rows: CoveringRow[] = [];

  const markCovered = (row: CoveringRow): void => {
    for (const [key, pair] of uncovered) {
      if (valueEquals(row[pair.a], pair.aValue) && valueEquals(row[pair.b], pair.bValue)) {
        uncovered.delete(key);
      }
    }
  };
  const appendRow = (row: CoveringRow): void => {
    if (!rows.some((existing) => canonicalJson(existing) === canonicalJson(row))) rows.push(row);
    markCovered(row);
  };
  for (const forced of forcedRows) appendRow(forced);

  while (uncovered.size > 0) {
    let best: PairWithWitness | undefined;
    let bestScore = -1;
    for (const candidate of uncovered.values()) {
      let score = 0;
      for (const pair of uncovered.values()) {
        if (
          valueEquals(candidate.witness[pair.a], pair.aValue) &&
          valueEquals(candidate.witness[pair.b], pair.bValue)
        ) {
          score += 1;
        }
      }
      if (score > bestScore) {
        best = candidate;
        bestScore = score;
      }
    }
    if (!best) break;
    const duplicate = rows.some(
      (existing) => canonicalJson(existing) === canonicalJson(best.witness)
    );
    if (!duplicate && input.maxRows !== undefined && rows.length >= input.maxRows) {
      throw new BenchError('bench.generator.too_many_rows', 'covering array exceeds max rows', {
        maxRows: input.maxRows,
        rows: rows.length + 1,
      });
    }
    appendRow(best.witness);
  }

  const receipt = receiptFor({ dimensions: input.dimensions, ...classified, budget });
  return {
    rows,
    uncoveredPairs: [
      ...classified.nonCompletable,
      ...[...uncovered.values()].map((pair) => pairLabel(pair.a, pair.aValue, pair.b, pair.bValue)),
    ],
    receipt: { ...receipt, covered: classified.pairs.length - uncovered.size },
  };
}
