import assert from "node:assert/strict";
import {
  SAME_RUN_HISTORY_POINTS,
  SAME_RUN_STRICT_MIN_POINTS,
  buildSameRunComparison,
  comparableHistoryByCaseFromRows,
  historyByCaseFromRows,
} from "./same-run-comparison-model.mjs";
import { buildSameRunHistorySql } from "./resolve-same-run-history.mjs";

const payload = ({
  caseId,
  engine = "v2",
  metric = "durationMs",
  actual,
  result = "pass",
}) => ({
  caseId,
  engine,
  result,
  thresholds:
    actual === undefined
      ? []
      : [{ metric, actual, max: actual * 4, passed: result !== "fail" }],
});

const steady = (n = 80, value = 100) => Array.from({ length: n }, () => value);

{
  const legacyRows = Array.from({ length: 60 }, (_, index) => ({
    caseId: "strict/outside-window",
    value: index + 101,
    startedAt: new Date(Date.UTC(2026, 4, 1 + index)).toISOString(),
  }));
  const strictRows = Array.from({ length: 55 }, (_, index) => ({
    caseId: "strict/outside-window",
    value: index + 1,
    startedAt: new Date(Date.UTC(2025, 0, 1 + index)).toISOString(),
    contractId: "contract-a",
    environmentClass: "runner:Linux:X64:postgres-e2e",
  }));
  const result = comparableHistoryByCaseFromRows(legacyRows, {
    strictRows,
    identityByCase: {
      "strict/outside-window": {
        contractId: "contract-a",
        environmentClass: "runner:Linux:X64:postgres-e2e",
      },
    },
  });
  assert.equal(
    result.compatibilityByCase["strict/outside-window"].mode,
    "strict",
  );
  assert.equal(result.valuesByCase["strict/outside-window"].length, 55);
}

{
  const history = historyByCaseFromRows([
    { caseId: "a", value: 10, startedAt: "2026-08-01T00:00:00.000Z" },
    { caseId: "a", value: 30, startedAt: "2026-08-03T00:00:00.000Z" },
    { caseId: "a", value: 20, startedAt: "2026-08-02T00:00:00.000Z" },
    { caseId: "b", value: 0, startedAt: "2026-08-02T00:00:00.000Z" },
  ]);
  assert.deepEqual(history.a, [10, 20, 30]);
  assert.equal(history.b, undefined);
}

{
  const rows = Array.from({ length: 60 }, (_, index) => ({
    caseId: "strict/a",
    value: index + 1,
    startedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    contractId: index < 55 ? "contract-a" : "contract-old",
    environmentClass: "runner:Linux:X64:postgres-e2e",
  }));
  const result = comparableHistoryByCaseFromRows(rows, {
    identityByCase: {
      "strict/a": {
        contractId: "contract-a",
        environmentClass: "runner:Linux:X64:postgres-e2e",
      },
    },
  });
  assert.equal(result.valuesByCase["strict/a"].length, 55);
  assert.equal(result.compatibilityByCase["strict/a"].mode, "strict");
}

{
  const rows = Array.from({ length: 60 }, (_, index) => ({
    caseId: "rollout/a",
    value: index + 1,
    startedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
    contractId: index < 10 ? "contract-a" : null,
    environmentClass: index < 10 ? "runner:Linux:X64:postgres-e2e" : null,
  }));
  const result = comparableHistoryByCaseFromRows(rows, {
    identityByCase: {
      "rollout/a": {
        contractId: "contract-a",
        environmentClass: "runner:Linux:X64:postgres-e2e",
      },
    },
  });
  assert.equal(result.valuesByCase["rollout/a"].length, 60);
  assert.equal(result.compatibilityByCase["rollout/a"].mode, "legacy-fallback");
  assert.equal(result.compatibilityByCase["rollout/a"].strictPoints, 10);
}

// The consumer-visible threshold is exact: 51 compatible points still use
// legacy, while 52 adopt strict. A stale JSON blob cannot override flat identity.
for (const compatible of [51, 52]) {
  const caseId = "strict/threshold";
  const identity = { contractId: "contract-a", environmentClass: "fixture" };
  const rows = Array.from({ length: 60 }, (_, index) => ({
    caseId,
    value: index + 1,
    startedAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
    contractId: index < compatible ? identity.contractId : "wrong-contract",
    environmentClass: identity.environmentClass,
    measurement: "not JSON and not a historical comparison input",
  }));
  const result = comparableHistoryByCaseFromRows(rows, { identityByCase: { [caseId]: identity } });
  assert.deepEqual(result.compatibilityByCase[caseId], {
    mode: compatible === 52 ? "strict" : "legacy-fallback",
    strictPoints: compatible,
    legacyPoints: 60,
  });
  assert.deepEqual(result.valuesByCase[caseId],
    Array.from({ length: compatible === 52 ? 52 : 60 }, (_, index) => index + 1));
}

{
  const rows = Array.from({ length: 80 }, (_, index) => ({
    caseId: "a",
    value: index + 1,
    startedAt: new Date(Date.UTC(2026, 0, 1 + index)).toISOString(),
  }));
  assert.equal(historyByCaseFromRows(rows).a.length, SAME_RUN_HISTORY_POINTS);
  assert.equal(historyByCaseFromRows(rows).a.at(-1), 80);
}

assert.equal(
  buildSameRunComparison({ payloads: [payload({ caseId: "a", actual: 100 })] })
    .available,
  false,
);

{
  const comparison = buildSameRunComparison({
    payloads: [
      payload({ caseId: "quiet/spike", actual: 200 }),
      payload({ caseId: "quiet/ok", actual: 100 }),
      payload({ caseId: "quiet/spike", engine: "v1", actual: 180 }),
    ],
    historyByCase: {
      "quiet/spike": steady(),
      "quiet/ok": steady(),
    },
  });
  assert.equal(comparison.available, true);
  assert.equal(comparison.judged, 2);
  assert.deepEqual(
    comparison.flagged.map((row) => row.caseId),
    ["quiet/spike"],
  );
  assert.equal(comparison.flagged[0].evidenceLevel, "anomaly_candidate");
  assert.ok(comparison.flagged[0].ratio > 1.9);
  assert.ok(comparison.flagged[0].thresholdRatio < 1.1);
}

{
  const noisy = Array.from({ length: 80 }, (_, index) =>
    index % 2 === 0 ? 100 : 400,
  );
  const comparison = buildSameRunComparison({
    payloads: [
      payload({ caseId: "record-read/group-three-levels", actual: 510 }),
    ],
    historyByCase: { "record-read/group-three-levels": noisy },
  });
  assert.equal(comparison.flagged.length, 0);
  assert.ok((comparison.skipped["too-noisy"] ?? 0) >= 1);
}

{
  const comparison = buildSameRunComparison({
    payloads: [
      payload({
        caseId: "record-read/zero-overhead",
        metric: "getRecordsQueryOverheadMs",
        actual: 200,
      }),
    ],
    historyByCase: { "record-read/zero-overhead": steady() },
  });
  assert.equal(comparison.flagged.length, 0);
  assert.equal(comparison.skipped.differential, 1);
}

{
  const comparison = buildSameRunComparison({
    payloads: [payload({ caseId: "new/case", actual: 100 })],
    historyByCase: {},
  });
  assert.equal(comparison.available, true);
  assert.equal(comparison.judged, 0);
  assert.equal(comparison.skipped["no-history"], 1);
}

{
  // Contract semantics only. SQL escaping and eligibility behavior are proven
  // against a real PostgreSQL database in check-same-run-history-postgres.mjs.
  assert.equal(buildSameRunHistorySql({ caseIds: [] }), undefined);
  assert.equal(
    buildSameRunHistorySql({
      caseIds: ["lookup/a"],
      strictOnly: true,
    }),
    undefined,
  );
}

console.log("same-run comparison model checks passed");
