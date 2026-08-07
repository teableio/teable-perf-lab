import assert from "node:assert/strict";
import {
  caseConfigDigest,
  caseFilePath,
  caseImportsOf,
  digestAllCases,
  normalizeCaseSource,
} from "./case-config-digest-model.mjs";

const BASE = `import { definePerfCase } from "../../framework/types";
export default definePerfCase({
  id: "record-read/50k-50fields-50x1k-pages",
  runner: "record-read",
  timeoutMs: 1_800_000,
  config: {
    rowCount: 50_000,
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 30_000 },
  },
});
`;

const DERIVED = `import { definePerfCase } from "../../framework/types";
import baseCase from "./50k-50fields-50x1k-pages.case";
export default definePerfCase({
  id: "record-read/50k-50fields-sort-three-fields",
  runner: "record-read",
  timeoutMs: 1_800_000,
  config: {
    ...baseCase.config,
    queryVariant: { expectedRowCount: 50_000 },
    threshold: { metric: "getRecordsQueryOverheadMs", maxMs: 30_000 },
  },
});
`;

const tree = (overrides = {}) => {
  const files = {
    "cases/record-read/50k-50fields-50x1k-pages.case.ts": BASE,
    "cases/record-read/50k-50fields-sort-three-fields.case.ts": DERIVED,
    ...overrides,
  };
  return (path) => files[path];
};

const digestOf = (caseId, readFile) => caseConfigDigest({ caseId, readFile });

// --- paths and imports ------------------------------------------------------

assert.equal(
  caseFilePath("record-read/50k-50fields-sort-three-fields"),
  "cases/record-read/50k-50fields-sort-three-fields.case.ts",
);

// Only relative `.case` imports are inheritance. A framework import describes
// how the case is run, not what it measures, and following it would drag the
// whole harness into every digest.
assert.deepEqual(
  caseImportsOf(
    DERIVED,
    "cases/record-read/50k-50fields-sort-three-fields.case.ts",
  ),
  ["cases/record-read/50k-50fields-50x1k-pages.case.ts"],
);
assert.deepEqual(
  caseImportsOf(`import x from "../lookup/shared.case";`, "cases/a/b.case.ts"),
  ["cases/lookup/shared.case.ts"],
);
assert.deepEqual(
  caseImportsOf(`import { z } from "zod";`, "cases/a/b.case.ts"),
  [],
);

// --- what changes a digest and what does not --------------------------------

// Retuning a threshold is routine and must not sever the history that shows the
// case got slower — which is precisely the history worth keeping.
{
  const before = digestOf("record-read/50k-50fields-50x1k-pages", tree());
  const after = digestOf(
    "record-read/50k-50fields-50x1k-pages",
    tree({
      "cases/record-read/50k-50fields-50x1k-pages.case.ts": BASE.replace(
        "maxMs: 30_000",
        "maxMs: 45_000",
      ),
    }),
  );
  assert.equal(before, after, "a maxMs change must not cut the series");
}

// Same for the run timeout.
assert.equal(
  digestOf("record-read/50k-50fields-50x1k-pages", tree()),
  digestOf(
    "record-read/50k-50fields-50x1k-pages",
    tree({
      "cases/record-read/50k-50fields-50x1k-pages.case.ts": BASE.replace(
        "timeoutMs: 1_800_000",
        "timeoutMs: 3_600_000",
      ),
    }),
  ),
);

// The metric names which number the series is made of. Change it and the values
// before and after are two different measurements sharing a case id.
assert.notEqual(
  digestOf("record-read/50k-50fields-50x1k-pages", tree()),
  digestOf(
    "record-read/50k-50fields-50x1k-pages",
    tree({
      "cases/record-read/50k-50fields-50x1k-pages.case.ts": BASE.replace(
        "getRecordsQueryOverheadMs",
        "getRecordsQueryPagedScanMs",
      ),
    }),
  ),
);

// The workload itself — this is the case the whole module exists for.
assert.notEqual(
  digestOf("record-read/50k-50fields-50x1k-pages", tree()),
  digestOf(
    "record-read/50k-50fields-50x1k-pages",
    tree({
      "cases/record-read/50k-50fields-50x1k-pages.case.ts": BASE.replace(
        "rowCount: 50_000",
        "rowCount: 100_000",
      ),
    }),
  ),
);

// A change to the base case must move the derived case's digest too. Hashing
// one file alone would miss every workload change made through inheritance.
{
  const before = digestOf("record-read/50k-50fields-sort-three-fields", tree());
  const after = digestOf(
    "record-read/50k-50fields-sort-three-fields",
    tree({
      "cases/record-read/50k-50fields-50x1k-pages.case.ts": BASE.replace(
        "rowCount: 50_000",
        "rowCount: 100_000",
      ),
    }),
  );
  assert.notEqual(
    before,
    after,
    "an inherited workload change must cut the series",
  );
}

// Reordering imports changes nothing about the workload, so it must not cut.
{
  const reordered = `import baseCase from "./50k-50fields-50x1k-pages.case";
import { definePerfCase } from "../../framework/types";
${DERIVED.split("\n").slice(2).join("\n")}`;
  assert.equal(
    digestOf("record-read/50k-50fields-sort-three-fields", tree()),
    digestOf(
      "record-read/50k-50fields-sort-three-fields",
      tree({
        "cases/record-read/50k-50fields-sort-three-fields.case.ts": reordered,
      }),
    ),
  );
}

// CRLF is a checkout setting, not a workload change.
assert.equal(normalizeCaseSource("a\r\nb"), normalizeCaseSource("a\nb"));

// --- absence ----------------------------------------------------------------

// A commit predating the case has no file, and that is a normal answer, not an
// error. It must not be a hash of nothing: two cases that both did not exist
// would then share a digest and their series would be spliced together.
assert.equal(digestOf("record-read/not-yet-written", tree()), undefined);

// A missing *inherited* file means the tree is inconsistent. Hashing what
// remains would produce a digest describing a case that never existed, so the
// whole digest is withheld and the consumer cuts the series instead.
assert.equal(
  digestOf(
    "record-read/50k-50fields-sort-three-fields",
    tree({ "cases/record-read/50k-50fields-50x1k-pages.case.ts": undefined }),
  ),
  undefined,
);

// --- bulk -------------------------------------------------------------------

{
  const digests = digestAllCases({
    caseIds: [
      "record-read/50k-50fields-50x1k-pages",
      "record-read/50k-50fields-sort-three-fields",
      "record-read/not-yet-written",
    ],
    readFile: tree(),
  });
  // Cases absent at this revision are omitted, not recorded as undefined — the
  // consumer's rule for "no digest" is the same either way.
  assert.deepEqual(Object.keys(digests).sort(), [
    "record-read/50k-50fields-50x1k-pages",
    "record-read/50k-50fields-sort-three-fields",
  ]);
  // A base and the case deriving from it are different workloads.
  assert.notEqual(
    digests["record-read/50k-50fields-50x1k-pages"],
    digests["record-read/50k-50fields-sort-three-fields"],
  );
}

console.log("case config digest model checks passed");
