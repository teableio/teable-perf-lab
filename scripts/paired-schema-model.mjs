import { createHash } from "node:crypto";

export const PAIRED_SCHEMA_PATHS = [
  "packages/db-main-prisma/prisma/template.prisma",
  "packages/db-main-prisma/prisma/postgres/schema.prisma",
  "packages/db-main-prisma/prisma/postgres/migrations",
  "community/packages/db-main-prisma/prisma/template.prisma",
  "community/packages/db-main-prisma/prisma/postgres/schema.prisma",
  "community/packages/db-main-prisma/prisma/postgres/migrations",
  "community/packages/db-data-prisma/prisma/schema.prisma",
  "community/packages/db-data-prisma/prisma/migrations",
];

export const schemaTreeDigestFromEntries = (entries) => {
  const normalized = String(entries ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort()
    .join("\n");
  if (!normalized) {
    throw new Error("Schema tree is empty; the checkout is incomplete.");
  }
  return createHash("sha256").update(normalized).digest("hex");
};

export const compareSchemaTrees = ({ baseEntries, candidateEntries }) => {
  const baseDigest = schemaTreeDigestFromEntries(baseEntries);
  const candidateDigest = schemaTreeDigestFromEntries(candidateEntries);
  return {
    compatible: baseDigest === candidateDigest,
    baseDigest,
    candidateDigest,
  };
};
