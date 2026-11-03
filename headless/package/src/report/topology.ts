export type DeclaredBusinessTopology = {
  tables: Array<{ id: string; name: string }>;
  links: Array<{ from: string; to: string; label: string }>;
};

type JsonObject = Record<string, unknown>;

const asObject = (value: unknown): JsonObject | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;

const asNonEmptyString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

/**
 * Derives a presentation-only ownership graph from the link fields declared in a
 * raw DotTea structure. Table and link order follow the archive declaration;
 * no ordering is inferred when the graph is cyclic or disconnected.
 */
// eslint-disable-next-line sonarjs/cognitive-complexity -- validates nested untrusted DotTea JSON defensively
export function deriveDeclaredBusinessTopology(structure: unknown): DeclaredBusinessTopology {
  const root = asObject(structure);
  const rawTables = Array.isArray(root?.tables) ? root.tables : [];
  const tables: DeclaredBusinessTopology['tables'] = [];
  const links: DeclaredBusinessTopology['links'] = [];
  const directedPairs = new Set<string>();

  for (const rawTable of rawTables) {
    const table = asObject(rawTable);
    const id = asNonEmptyString(table?.id);
    const name = asNonEmptyString(table?.name);
    if (id && name) tables.push({ id, name });
  }

  for (const rawTable of rawTables) {
    const table = asObject(rawTable);
    const containingTableId = asNonEmptyString(table?.id);
    if (!containingTableId || !Array.isArray(table?.fields)) continue;

    for (const rawField of table.fields) {
      const field = asObject(rawField);
      if (field?.type !== 'link') continue;
      const options = asObject(field.options);
      const foreignTableId = asNonEmptyString(options?.foreignTableId);
      const relationship = options?.relationship;
      const fieldName = asNonEmptyString(field.name);
      if (!foreignTableId || !fieldName) continue;

      const pair =
        relationship === 'manyOne'
          ? { from: foreignTableId, to: containingTableId }
          : relationship === 'manyMany'
            ? { from: containingTableId, to: foreignTableId }
            : undefined;
      if (!pair) continue;

      const pairKey = `${pair.from}\0${pair.to}`;
      if (directedPairs.has(pairKey)) continue;
      directedPairs.add(pairKey);
      const label = `${asNonEmptyString(table?.name) ?? containingTableId}.${fieldName} → ${tables.find((candidate) => candidate.id === foreignTableId)?.name ?? foreignTableId} (${String(relationship)})`;
      links.push({ ...pair, label });
    }
  }

  return { tables, links };
}
