import pg from "pg";

const { Client } = pg;

export const queryPerfDb = async <T extends Record<string, unknown>>(
  sql: string,
  values: unknown[] = [],
): Promise<T[]> => {
  if (!/^\s*select\b/i.test(sql)) {
    throw new Error("queryPerfDb only allows SELECT");
  }

  const databaseUrl = process.env.PRISMA_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("PRISMA_DATABASE_URL is not set");
  }

  const client = new Client({ connectionString: databaseUrl });
  try {
    await client.connect();
    const result = await client.query<T>(sql, values);
    return result.rows;
  } finally {
    await client.end();
  }
};
