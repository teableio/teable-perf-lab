import assert from "node:assert/strict";
import test from "node:test";
import {
  getStoredFieldDuplicateSeedIdentity,
  getStoredFieldDuplicateSeedIdentityCase,
  shouldCleanupStoredFieldDuplicateFixture,
} from "./field-duplicate-stored-model.ts";

test("stored field duplicate siblings can share one explicit seed identity", () => {
  const seedIdentity = "scalar-matrix-50k";
  const first = getStoredFieldDuplicateSeedIdentityCase(
    { id: "field-duplicate/50k-owner" },
    seedIdentity,
  );
  const second = getStoredFieldDuplicateSeedIdentityCase(
    { id: "field-duplicate/50k-status" },
    seedIdentity,
  );

  assert.equal(first.id, "field-duplicate/shared-scalar-matrix-50k");
  assert.equal(first.id, second.id);
  assert.deepEqual(getStoredFieldDuplicateSeedIdentity(seedIdentity), {
    seedIdentity,
  });
  assert.equal(getStoredFieldDuplicateSeedIdentity(), undefined);
});

test("isolated execute jobs still restore reusable sibling fixtures", () => {
  assert.equal(
    shouldCleanupStoredFieldDuplicateFixture({
      executeDbIsolated: true,
      reusableSeed: true,
    }),
    true,
  );
  assert.equal(
    shouldCleanupStoredFieldDuplicateFixture({
      executeDbIsolated: true,
      reusableSeed: false,
    }),
    false,
  );
  assert.equal(
    shouldCleanupStoredFieldDuplicateFixture({
      executeDbIsolated: false,
      reusableSeed: false,
    }),
    true,
  );
});
