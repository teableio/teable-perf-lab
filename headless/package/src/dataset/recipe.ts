import type { BenchDatasetRecipe } from '../case/manifest';
import { BenchError } from '../errors';
import { mulberry32 } from './prng';
export type GeneratedRow = {
  readonly index: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly links: Readonly<
    Record<string, { readonly targetTable: string; readonly targetIndices: ReadonlyArray<number> }>
  >;
};

export type RecipeFieldShape = {
  readonly type: string;
  readonly isComputed: boolean;
  readonly isPrimary?: boolean;
  readonly isMultiple?: boolean;
  readonly choices?: ReadonlyArray<string>;
  readonly ratingMax?: number;
};

const selectChoices = (
  table: string,
  fieldName: string,
  field: RecipeFieldShape,
  explicitChoices: ReadonlyArray<string> | undefined
): ReadonlyArray<string> => {
  const schemaChoices = field.choices ?? [];
  if (explicitChoices) {
    const unknown = explicitChoices.filter((choice) => !schemaChoices.includes(choice));
    if (unknown.length > 0) {
      throw new BenchError(
        'bench.recipe.choice_unknown',
        `field ${table}.${fieldName} has recipe choices not present in the schema: ${unknown.join(', ')}`
      );
    }
  }
  return [...new Set(explicitChoices ?? schemaChoices)];
};

const pickDistinctIndices = (
  rng: () => number,
  count: number,
  take: number
): ReadonlyArray<number> => {
  const pool = Array.from({ length: count }, (_, index) => index);
  for (let i = 0; i < take; i++) {
    const swapIndex = i + Math.floor(rng() * (count - i));
    const current = pool[i]!;
    pool[i] = pool[swapIndex]!;
    pool[swapIndex] = current;
  }
  return pool.slice(0, take);
};

export function generateTableRows(input: {
  table: string;
  rows: number;
  fields: Readonly<Record<string, RecipeFieldShape>>;
  recipe: BenchDatasetRecipe['tables'][string] | undefined;
  targetRowCounts: Readonly<Record<string, number>>;
  seed: number;
  actorId?: string;
}): ReadonlyArray<GeneratedRow> {
  const { table, rows, fields, recipe, targetRowCounts, seed, actorId } = input;

  if (!Number.isInteger(rows) || rows <= 0) {
    throw new BenchError(
      'bench.recipe.rows_invalid',
      `table ${table} needs a positive integer row count, received ${rows}`
    );
  }

  const rng = mulberry32(seed);
  const fieldNames = Object.keys(fields).sort();
  const linkFieldNames = fieldNames
    .filter((name) => fields[name]!.type === 'link' || Boolean(recipe?.fields[name]?.link))
    .filter((name) => !fields[name]!.isComputed);
  const valueFieldNames = fieldNames.filter(
    (name) =>
      !fields[name]!.isComputed && fields[name]!.type !== 'link' && !recipe?.fields[name]?.link
  );
  const choicesByField = new Map<string, ReadonlyArray<string>>();
  for (const name of valueFieldNames) {
    if (fields[name]!.type === 'singleSelect' || fields[name]!.type === 'multipleSelect') {
      choicesByField.set(
        name,
        selectChoices(table, name, fields[name]!, recipe?.fields[name]?.choices)
      );
    }
  }

  const generated: GeneratedRow[] = [];

  for (let rowIndex = 0; rowIndex < rows; rowIndex++) {
    const values: Record<string, unknown> = {};

    for (const fieldName of valueFieldNames) {
      const field = fields[fieldName]!;
      const config = recipe?.fields[fieldName];
      let value: unknown;

      switch (field.type) {
        case 'singleLineText':
        case 'longText':
          // Zero-pad the index itself: `padEnd` on the raw index makes
          // `text-1` and `text-10` the same 16-character primary value.
          value = `text-${String(rowIndex).padStart(6, '0')}`.padEnd(config?.width ?? 16, '0');
          break;
        case 'number': {
          const min = config?.min ?? 0;
          const max = config?.max ?? 1000;
          if (config?.distribution === 'constant') {
            value = config.min ?? 1;
          } else if (config?.distribution === 'zipf') {
            const rank = Math.max(1, Math.floor(max * rng() ** 2));
            value = Math.max(1, Math.round(max / rank));
          } else if (config?.distribution === 'clustered') {
            value = min + Math.floor(rng() * Math.max(1, config.cardinality ?? 10));
          } else {
            value = max <= min ? min : Math.floor(min + rng() * (max - min));
          }
          break;
        }
        case 'date':
          value = new Date(Date.UTC(2020, 0, 1) + rowIndex * 86_400_000).toISOString();
          break;
        case 'checkbox':
          value = rng() < 0.5;
          break;
        case 'singleSelect':
        case 'multipleSelect': {
          const choices = choicesByField.get(fieldName)!;
          if (field.type === 'singleSelect') {
            value = choices.length > 0 ? choices[Math.floor(rng() * choices.length)]! : null;
          } else {
            const take = Math.min(choices.length, 1 + Math.floor(rng() * 3));
            const indices = [...pickDistinctIndices(rng, choices.length, take)].sort(
              (left, right) => left - right
            );
            value = indices.map((index) => choices[index]!);
          }
          break;
        }
        case 'rating':
          value = 1 + Math.floor(rng() * (field.ratingMax ?? 5));
          break;
        case 'user': {
          if (!actorId) {
            throw new BenchError(
              'bench.recipe.actor_missing',
              `user field ${table}.${fieldName} requires the runtime actor id`
            );
          }
          const user = { id: actorId };
          value = field.isMultiple ? [user] : user;
          break;
        }
        default:
          value = null;
      }

      const nullFraction = config?.nullFraction ?? 0;
      if (nullFraction > 0 && rng() < nullFraction) {
        value = null;
      }

      values[fieldName] = value;
    }

    const links: Record<string, { targetTable: string; targetIndices: ReadonlyArray<number> }> = {};

    for (const fieldName of linkFieldNames) {
      const link = recipe?.fields[fieldName]?.link;
      if (!link) continue;

      const targetTable = link.table;
      const targetRowCount = targetRowCounts[targetTable];

      if (targetRowCount === undefined) {
        throw new BenchError(
          'bench.recipe.target_rows_missing',
          `link field ${table}.${fieldName} references table ${targetTable} without declared row count`
        );
      }

      if (link.relationship === 'manyOne') {
        if (link.fanout !== undefined && link.fanout !== 1) {
          throw new BenchError(
            'bench.recipe.fanout_invalid',
            `manyOne relation ${table}.${fieldName} must not declare fanout ${link.fanout}`
          );
        }
        if (targetRowCount <= 0) {
          throw new BenchError(
            'bench.recipe.fanout_exceeds_rows',
            `link field ${table}.${fieldName} needs at least one row in ${targetTable}`
          );
        }
        links[fieldName] = {
          targetTable,
          targetIndices: [Math.floor(rng() * targetRowCount)],
        };
        continue;
      }

      if (link.relationship !== 'manyMany') {
        throw new BenchError(
          'bench.recipe.relationship_invalid',
          `link field ${table}.${fieldName} has unsupported relationship ${String(
            link.relationship
          )}`
        );
      }

      const fanout = link.fanout ?? 1;
      if (!Number.isInteger(fanout) || fanout <= 0) {
        throw new BenchError(
          'bench.recipe.fanout_invalid',
          `link field ${table}.${fieldName} needs a positive integer fanout, received ${fanout}`
        );
      }
      if (fanout > targetRowCount) {
        throw new BenchError(
          'bench.recipe.fanout_exceeds_rows',
          `link field ${table}.${fieldName} fanout ${fanout} exceeds ${targetTable} rows ${targetRowCount}`
        );
      }

      links[fieldName] = {
        targetTable,
        targetIndices: pickDistinctIndices(rng, targetRowCount, fanout),
      };
    }

    generated.push({ index: rowIndex, fields: values, links });
  }

  return generated;
}
