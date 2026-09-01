import assert from "node:assert/strict";
import {
  compareSchemaTrees,
  schemaTreeDigestFromEntries,
} from "./paired-schema-model.mjs";

const base = [
  "100644 blob aaa packages/db-main-prisma/prisma/postgres/schema.prisma",
  "100644 blob bbb community/packages/db-data-prisma/prisma/schema.prisma",
].join("\n");
const reordered = base.split("\n").reverse().join("\n");

assert.equal(
  schemaTreeDigestFromEntries(base),
  schemaTreeDigestFromEntries(reordered),
);
assert.equal(
  compareSchemaTrees({ baseEntries: base, candidateEntries: reordered })
    .compatible,
  true,
);
assert.equal(
  compareSchemaTrees({
    baseEntries: base,
    candidateEntries: base.replace("blob bbb", "blob ccc"),
  }).compatible,
  false,
);
assert.throws(() => schemaTreeDigestFromEntries(""), /Schema tree is empty/);

console.log("paired schema model checks passed");
