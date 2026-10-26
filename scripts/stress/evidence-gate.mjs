#!/usr/bin/env node
// Deterministic evidence-key generator, verdict gate, capacity claim, and cost
// coverage helpers for the stress-test evidence contract.
//
// The contract is the authority:
//   docs/operations/byodb-stress-evidence-contract.md
//   docs/byodb-stress-plan.md
//
// Design rules:
//   * 判定 (verdict) is derived from evidence rows, never hand-filled. A human
//     may only downgrade the derived verdict (pass > capacity_only >
//     inconclusive > fail > aborted); upgrades are rejected.
//   * Max_Sustainable_RPS stays null until a failing ladder step AND the
//     required repeats exist. Until then Max_Passing_RPS is a lower bound
//     (Capacity_Bound=lower).
//   * Actual_Run_Cost is only emitted when cost coverage is full; a partial
//     component set yields null + Cost_Coverage=partial.
//   * Evidence keys have exactly one generator. `v1` reproduces the legacy
//     drifted keys that already exist in staging (so reruns stay idempotent);
//     `v2` is the canonical contract format used after the key migration.

export const EVIDENCE_KEY_FORMAT = "stress-evidence-v2-keys";

export const VERDICT_RANK = Object.freeze({
  pass: 0,
  capacity_only: 1,
  inconclusive: 2,
  fail: 3,
  aborted: 4,
});

export const VERDICTS = Object.freeze(Object.keys(VERDICT_RANK));

export const CAPACITY_BOUNDS = Object.freeze(["lower", "point"]);

export const COST_COMPONENTS = Object.freeze([
  "db",
  "appnode",
  "loadgen",
  "observability",
  "ops",
  "other",
]);

const CORE_COST_COMPONENTS = Object.freeze(["db", "appnode", "loadgen", "ops"]);

const MODES = new Set(["shared", "byodb"]);

function required(parts, name) {
  const value = parts?.[name];
  if (value === undefined || value === null || value === "") {
    throw new Error(`evidence key: ${name} is required`);
  }
  return value;
}

function segment(value) {
  const text = String(value);
  if (text === "") throw new Error("evidence key: empty component");
  // Encode ":" as %3A so instance keys such as host:port/db cannot be
  // confused with the dimension separator.
  return encodeURIComponent(text);
}

function optionalRepeat(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(
      `evidence key: repeat must be a positive integer: ${value}`,
    );
  }
  return number;
}

function optionalMode(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!MODES.has(String(value))) {
    throw new Error(`evidence key: mode must be shared|byodb: ${value}`);
  }
  return String(value);
}

// Legacy key shape (pre-2026-10-25). Rows in staging were written with this
// shape, so it must stay byte-identical for idempotent reruns of old bundles.
function withLegacyDimensions(base, dimensions) {
  const suffix = [];
  for (const [name, value] of dimensions) {
    if (value === undefined || value === null || value === "") continue;
    suffix.push(`${name}=${encodeURIComponent(String(value))}`);
  }
  return suffix.length ? `${base}:${suffix.join(":")}` : base;
}

function legacyWindowMs(parts, fallback) {
  const raw = parts?.windowStartMs ?? parts?.windowStart;
  if (raw === undefined || raw === null || raw === "") {
    if (fallback === undefined)
      throw new Error("evidence key: windowStart is required");
    return fallback;
  }
  const number = typeof raw === "number" ? raw : Date.parse(String(raw));
  if (!Number.isFinite(number))
    throw new Error(`evidence key: invalid windowStart ${raw}`);
  return number;
}

function buildV2(kind, parts) {
  switch (kind) {
    case "scenario":
      return `scenario:${segment(required(parts, "scenarioId"))}`;
    case "dataset":
      return `ds:${segment(required(parts, "datasetId"))}`;
    case "run":
      return `lst:${segment(required(parts, "runId"))}`;
    case "result": {
      const runId = segment(required(parts, "runId"));
      const scenarioId = segment(required(parts, "scenarioId"));
      const mode = segment(optionalMode(required(parts, "mode")));
      const repeat = optionalRepeat(required(parts, "repeat"));
      const operation = parts.operationKey ? segment(parts.operationKey) : null;
      return `lst:${runId}:scenario:${scenarioId}:${mode}:${repeat}${operation ? `:${operation}` : ""}`;
    }
    case "metric": {
      const runId = segment(required(parts, "runId"));
      const metric = segment(required(parts, "metricKey"));
      const scenarioId = segment(parts.scenarioId || "all");
      const windowStartMs = legacyWindowMs(parts);
      const dims = [];
      if (parts.operationKey) dims.push(`op=${segment(parts.operationKey)}`);
      if (parts.dbRole && parts.dbRole !== "all")
        dims.push(`db=${segment(parts.dbRole)}`);
      if (parts.instanceKey && parts.instanceKey !== "all") {
        dims.push(`instance=${segment(parts.instanceKey)}`);
      }
      return `lst:${runId}:metric:${metric}:${scenarioId}:${windowStartMs}${
        dims.length ? `:${dims.join(":")}` : ""
      }`;
    }
    case "cost": {
      const runId = segment(required(parts, "runId"));
      const scenarioId = segment(parts.scenarioId || "all");
      const component = segment(required(parts, "component"));
      const mode = optionalMode(parts.mode);
      const repeat = optionalRepeat(parts.repeat);
      const dims = [];
      if (mode) dims.push(`mode=${mode}`);
      if (repeat) dims.push(`repeat=${repeat}`);
      return `lst:${runId}:byodb-cost:${scenarioId}:${component}${
        dims.length ? `:${dims.join(":")}` : ""
      }`;
    }
    case "resource":
      return `lst:${segment(required(parts, "runId"))}:resource:${segment(
        required(parts, "resourceKey"),
      )}`;
    case "check": {
      const runId = segment(required(parts, "runId"));
      const checkKey = segment(required(parts, "checkKey"));
      const dims = [];
      if (parts.scenarioId) dims.push(`scenario=${segment(parts.scenarioId)}`);
      const mode = optionalMode(parts.mode);
      if (mode) dims.push(`mode=${mode}`);
      const repeat = optionalRepeat(parts.repeat);
      if (repeat) dims.push(`repeat=${repeat}`);
      if (parts.operationKey) dims.push(`op=${segment(parts.operationKey)}`);
      return `lst:${runId}:check:${checkKey}${dims.length ? `:${dims.join(":")}` : ""}`;
    }
    case "report":
      return `report:${segment(required(parts, "reportKey"))}:${segment(
        parts.reportVersion || "v1",
      )}`;
    case "bottleneck":
      return `lst:${segment(required(parts, "runId"))}:bottleneck:${segment(
        required(parts, "seq"),
      )}`;
    default:
      throw new Error(`evidence key: unknown kind ${kind}`);
  }
}

function buildLegacy(kind, parts) {
  switch (kind) {
    case "result":
      return withLegacyDimensions(
        `lst:${required(parts, "runId")}:scenario:${required(parts, "scenarioId")}`,
        [
          ["mode", parts.mode],
          ["repeat", parts.repeat],
          ["op", parts.operationKey],
        ],
      );
    case "metric": {
      const windowStartMs = legacyWindowMs(parts, parts.fallbackWindowStartMs);
      return withLegacyDimensions(
        `lst:${required(parts, "runId")}:metric:${required(parts, "metricKey")}:${
          parts.scenario || "all"
        }:${windowStartMs}`,
        [
          ["scenario", parts.scenarioId],
          ["mode", parts.mode],
          ["repeat", parts.repeat],
          ["op", parts.operationKey],
          ["db", parts.dbRole === "all" ? undefined : parts.dbRole],
          [
            "instance",
            parts.instanceKey === "all" ? undefined : parts.instanceKey,
          ],
        ],
      );
    }
    case "cost":
      return withLegacyDimensions(
        `lst:${required(parts, "runId")}:byodb-cost:${parts.scenarioId || "all"}:${required(
          parts,
          "component",
        )}`,
        [
          ["mode", parts.mode],
          ["repeat", parts.repeat],
        ],
      );
    case "check":
      return withLegacyDimensions(
        `lst:${required(parts, "runId")}:check:${required(parts, "checkKey")}`,
        [
          ["scenario", parts.scenarioId],
          ["mode", parts.mode],
          ["repeat", parts.repeat],
          ["op", parts.operationKey],
        ],
      );
    case "run":
      return `lst:${required(parts, "runId")}`;
    default:
      // scenario/dataset/resource/report/bottleneck are identical in v1.
      return buildV2(kind, parts);
  }
}

/**
 * Build the single canonical evidence key for a table row.
 *
 * @param {'scenario'|'dataset'|'run'|'result'|'metric'|'cost'|'resource'|'check'|'report'|'bottleneck'} kind
 * @param {object} parts
 * @param {{format?: 'v2'|'v1'}} [options]
 */
export function buildEvidenceKey(kind, parts, options = {}) {
  const format = options.format || "v2";
  if (format === "v1") return buildLegacy(kind, parts);
  if (format !== "v2")
    throw new Error(`evidence key: unknown format ${format}`);
  return buildV2(kind, parts);
}

const KEY_PREFIXES = [
  ["scenario:", "scenario"],
  ["ds:", "dataset"],
  ["lst:", "run"],
  ["report:", "report"],
];

/** Classify a key for uniqueness reports. Returns null for an unknown shape. */
export function classifyEvidenceKey(key) {
  if (typeof key !== "string" || !key) return null;
  for (const [prefix, kind] of KEY_PREFIXES) {
    if (key.startsWith(prefix)) {
      if (kind !== "run") return kind;
      if (key.includes(":scenario:")) return "result";
      if (key.includes(":metric:")) return "metric";
      if (key.includes(":byodb-cost:")) return "cost";
      if (key.includes(":resource:")) return "resource";
      if (key.includes(":check:")) return "check";
      if (key.includes(":bottleneck:")) return "bottleneck";
      return "run";
    }
  }
  return null;
}

/**
 * Detect duplicate evidence keys. `rows` accepts `{table, key}` or a bare key
 * string; an empty key is reported as `missing` (never silently dropped).
 */
export function findDuplicateKeys(rows) {
  const seen = new Map();
  const missing = [];
  const duplicates = [];
  for (const row of rows) {
    const key = typeof row === "string" ? row : row?.key;
    const table = typeof row === "string" ? undefined : row?.table;
    if (!key) {
      missing.push({ table, key: key ?? null });
      continue;
    }
    const bucket = table ? `${table}\u0000${key}` : key;
    const existing = seen.get(bucket);
    if (existing) {
      duplicates.push({
        table,
        key,
        kind: classifyEvidenceKey(key),
        count: existing.count + 1,
      });
      existing.count += 1;
    } else {
      seen.set(bucket, { table, key, count: 1 });
    }
  }
  return { duplicates, missing };
}

// ---------------------------------------------------------------------------
// Verdict gate
// ---------------------------------------------------------------------------

function hasText(value) {
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null;
}

function isFiniteNumber(value) {
  return (
    value !== null &&
    value !== undefined &&
    value !== "" &&
    Number.isFinite(Number(value))
  );
}

function asNumber(value) {
  return isFiniteNumber(value) ? Number(value) : null;
}

function blocker(code, severity, detail) {
  return { code, severity, detail };
}

const SEVERITY_RANK = { inconclusive: 0, fail: 1, aborted: 2 };

function worstVerdict(blockers, fallback = "pass") {
  let verdict = fallback;
  for (const item of blockers) {
    if (SEVERITY_RANK[item.severity] > (SEVERITY_RANK[verdict] ?? -1)) {
      verdict = item.severity;
    }
  }
  return verdict;
}

function parseRatio(value) {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value === "object") return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return null;
  }
}

/**
 * Registry snapshot required for the gate. Either pass `bundle.registry`:
 * `{ sloP95Ms, maxErrorRatePct, perOperationSloP95Ms?, expectsV2? }`, or set
 * `run.sloP95Ms`/`run.maxErrorRatePct` explicitly.
 */
export function resolveRegistrySpec(bundle) {
  const registry = bundle?.registry || {};
  const run = bundle?.run || {};
  const sloP95Ms = asNumber(registry.sloP95Ms ?? run.sloP95Ms);
  const maxErrorRatePct = asNumber(
    registry.maxErrorRatePct ??
      run.maxErrorRatePct ??
      (isFiniteNumber(registry.maxErrorRateFrac)
        ? Number(registry.maxErrorRateFrac) * 100
        : null),
  );
  return {
    sloP95Ms,
    maxErrorRatePct: maxErrorRatePct ?? 1,
    perOperationSloP95Ms: registry.perOperationSloP95Ms || {},
    expectsV2: Boolean(registry.expectsV2 ?? run.expectsV2 ?? false),
  };
}

function scenarioSlo(spec, scenario) {
  const explicit = asNumber(scenario?.sloP95Ms);
  if (explicit !== null) return explicit;
  const operation = scenario?.operationKey ?? scenario?.operation;
  if (operation && isFiniteNumber(spec.perOperationSloP95Ms?.[operation])) {
    return Number(spec.perOperationSloP95Ms[operation]);
  }
  return spec.sloP95Ms;
}

function droppedIterationsBlockers(bundle, scenarios) {
  const blockers = [];
  const totalRequests = asNumber(bundle?.run?.totalRequests);
  for (const metric of bundle?.metrics || []) {
    const name = String(metric.metric || "").toLowerCase();
    if (!name.includes("dropped")) continue;
    const dropped = asNumber(metric.value);
    if (dropped === null) continue;
    const scenario = scenarios.find(
      (item) =>
        metric.scenario && item.scenario && metric.scenario === item.scenario,
    );
    const requests =
      asNumber(metric.requests) ??
      asNumber(scenario?.requests) ??
      totalRequests ??
      null;
    if (requests === null) {
      blockers.push(
        blocker(
          "DROPPED_SAMPLE_UNKNOWN",
          "inconclusive",
          `dropped_iterations=${dropped} but request count is unknown`,
        ),
      );
      continue;
    }
    const limit = Math.max(10, 0.01 * requests);
    if (dropped > limit) {
      blockers.push(
        blocker(
          "DROPPED_ITERATIONS",
          "aborted",
          `dropped_iterations=${dropped} exceeds ${limit.toFixed(0)} for ${requests} requests`,
        ),
      );
    }
  }
  return blockers;
}

function explicitGuardrailBlockers(bundle) {
  const blockers = [];
  for (const item of bundle?.guardrails || []) {
    if (item?.breached === true || item?.status === "breach") {
      blockers.push(
        blocker(
          "GUARDRAIL_BREACH",
          "aborted",
          `${item.rule || "guardrail"} breached` +
            (isFiniteNumber(item.value) ? ` (value=${item.value}` : "") +
            (isFiniteNumber(item.threshold)
              ? `, threshold=${item.threshold})`
              : isFiniteNumber(item.value)
                ? ")"
                : ""),
        ),
      );
    }
  }
  for (const metric of bundle?.metrics || []) {
    if (metric?.guardrail === true && metric?.overThreshold === true) {
      blockers.push(
        blocker(
          "GUARDRAIL_BREACH",
          "aborted",
          `${metric.metric} over threshold` +
            (isFiniteNumber(metric.value) ? ` (value=${metric.value})` : ""),
        ),
      );
    }
  }
  return blockers;
}

function correctnessBlockers(bundle, { umbrella, strict }) {
  const blockers = [];
  const checks = bundle?.correctness || [];
  if (umbrella && checks.length === 0) {
    blockers.push(
      blocker(
        "CORRECTNESS_ROWS_MISSING",
        "inconclusive",
        "no 压测正确性检查 rows",
      ),
    );
  }
  for (const check of checks) {
    const status = String(check.status || "").toLowerCase();
    const toleranceMissing =
      !isFiniteNumber(check.delta) || !isFiniteNumber(check.tolerance);
    if (status === "fail") {
      blockers.push(
        blocker(
          "CORRECTNESS_FAIL",
          "fail",
          `${check.checkKey || "check"} failed: ${check.observed || "no observed value"}`,
        ),
      );
    } else if (status === "partial" || status === "skipped" || !status) {
      blockers.push(
        blocker(
          "CORRECTNESS_PARTIAL",
          "inconclusive",
          `${check.checkKey || "check"} status=${status || "missing"}`,
        ),
      );
    }
    if (toleranceMissing) {
      blockers.push(
        blocker(
          "CORRECTNESS_TOLERANCE_MISSING",
          "inconclusive",
          `${check.checkKey || "check"} needs Delta and Tolerance; a null pair counts as partial`,
        ),
      );
    }
    if (strict) {
      if (!hasText(check.sampleRef ?? check.sample_ref)) {
        blockers.push(
          blocker(
            "CORRECTNESS_SAMPLE_MISSING",
            "inconclusive",
            `${check.checkKey || "check"} needs Sample_Ref`,
          ),
        );
      }
      if (!hasText(check.observed)) {
        blockers.push(
          blocker(
            "CORRECTNESS_OBSERVED_MISSING",
            "inconclusive",
            `${check.checkKey || "check"} needs an observed value`,
          ),
        );
      }
      if ((check.permissionCheck ?? check.permission_check) !== true) {
        blockers.push(
          blocker(
            "CORRECTNESS_PERMISSION_UNVERIFIED",
            "inconclusive",
            `${check.checkKey || "check"} needs Permission_Check=true`,
          ),
        );
      }
    }
    if (!check.verifier || check.verifier === "same-token") {
      blockers.push(
        blocker(
          "CORRECTNESS_NOT_INDEPENDENT",
          "inconclusive",
          `${check.checkKey || "check"} must be verified by a different token or psql`,
        ),
      );
    }
  }
  return blockers;
}

function cleanupBlockers(bundle, { umbrella, strict }) {
  const blockers = [];
  const resources = bundle?.resources || [];
  const run = bundle?.run || {};
  if (run.cleanupStatus === "cleanup_failed") {
    blockers.push(
      blocker("CLEANUP_FAILED", "fail", "run Cleanup_Status=cleanup_failed"),
    );
  }
  if (umbrella && run.cleanupStatus !== "verified") {
    blockers.push(
      blocker(
        "CLEANUP_UNVERIFIED",
        "fail",
        `run Cleanup_Status=${run.cleanupStatus || "missing"} (requires verified)`,
      ),
    );
  }
  if (
    umbrella &&
    resources.length === 0 &&
    Number(run.dbPhysicalCount || 0) > 0
  ) {
    blockers.push(
      blocker(
        "RESOURCE_ROWS_MISSING",
        "inconclusive",
        "DB_Physical_Count > 0 but no 压测资源生命周期 rows",
      ),
    );
  }
  for (const resource of resources) {
    const id = resource.resourceId || "resource";
    if (resource.deletedAtSource === "batch") {
      blockers.push(
        blocker(
          "RESOURCE_BATCH_DELETED_AT",
          "fail",
          `${id}: Deleted_At is batch-stamped, not a per-resource receipt`,
        ),
      );
    }
    if (resource.deletionVerified !== true) {
      blockers.push(
        blocker(
          "RESOURCE_DELETION_UNVERIFIED",
          "fail",
          `${id}: Deletion_Verified is not true`,
        ),
      );
    }
    if (resource.cleanupStatus && resource.cleanupStatus !== "verified") {
      blockers.push(
        blocker(
          "RESOURCE_CLEANUP_UNVERIFIED",
          "fail",
          `${id}: Cleanup_Status=${resource.cleanupStatus}`,
        ),
      );
    }
    const hasReceipt =
      (typeof resource.receiptJson === "string" &&
        resource.receiptJson.trim() !== "") ||
      (resource.receiptJson &&
        typeof resource.receiptJson === "object" &&
        Object.keys(resource.receiptJson).length > 0);
    const hasEvidenceCode = hasText(resource.deletionEvidenceCode);
    if (strict) {
      if (!hasReceipt) {
        blockers.push(
          blocker(
            "RESOURCE_RECEIPT_MISSING",
            "fail",
            `${id}: needs a non-empty Receipt_JSON`,
          ),
        );
      }
      if (!hasEvidenceCode) {
        blockers.push(
          blocker(
            "RESOURCE_EVIDENCE_CODE_MISSING",
            "fail",
            `${id}: needs an explicit Deletion_Evidence_Code`,
          ),
        );
      }
      if (resource.deletedAtSource !== "per-resource-receipt") {
        blockers.push(
          blocker(
            "RESOURCE_DELETED_AT_SOURCE_UNVERIFIED",
            "fail",
            `${id}: Deleted_At_Source must be per-resource-receipt`,
          ),
        );
      }
    } else if (!hasReceipt && !hasEvidenceCode) {
      blockers.push(
        blocker(
          "RESOURCE_RECEIPT_MISSING",
          "fail",
          `${id}: needs Receipt_JSON or Deletion_Evidence_Code (per-resource proof)`,
        ),
      );
    }
  }
  return blockers;
}

function v2Blockers(bundle, spec) {
  if (!spec.expectsV2) return [];
  const ratios = parseRatio(bundle?.run?.v2RatioPerEndpoint);
  if (
    !ratios ||
    typeof ratios !== "object" ||
    Object.keys(ratios).length === 0
  ) {
    return [
      blocker(
        "V2_RATIO_MISSING",
        "inconclusive",
        "registry expects v2 attribution but V2_Ratio_Per_Endpoint is empty",
      ),
    ];
  }
  const blockers = [];
  for (const [endpoint, value] of Object.entries(ratios)) {
    const entry = typeof value === "object" ? value : { observed: value };
    if (entry.observed === null || entry.observed === undefined) {
      blockers.push(
        blocker(
          "V2_RATIO_MISSING",
          "inconclusive",
          `${endpoint}: observed ratio is null`,
        ),
      );
      continue;
    }
    if (isFiniteNumber(entry.expected)) {
      const tolerance = isFiniteNumber(entry.tolerance)
        ? Number(entry.tolerance)
        : 0.05;
      const delta = Math.abs(Number(entry.observed) - Number(entry.expected));
      if (delta > tolerance) {
        blockers.push(
          blocker(
            "V2_RATIO_DEVIATION",
            "inconclusive",
            `${endpoint}: observed=${entry.observed} expected=${entry.expected} tolerance=${tolerance}`,
          ),
        );
      }
    }
  }
  return blockers;
}

function evidenceRowState(bundle, { umbrella, strict }) {
  if (!umbrella && !strict) return { blockers: [], gaps: [] };
  const blockers = [];
  const gaps = [];
  if (!(bundle?.scenarios || []).length) {
    blockers.push(
      blocker("RESULT_ROWS_MISSING", "inconclusive", "no 压测场景结果 rows"),
    );
  }
  if (!(bundle?.metrics || []).length) {
    blockers.push(
      blocker("METRIC_ROWS_MISSING", "inconclusive", "no 压测指标窗口 rows"),
    );
  }
  if (!umbrella) return { blockers, gaps };
  // Report and cost gaps downgrade report/cost conclusions, not the
  // performance verdict itself unless the bundle claims canonical v2.
  if (!(bundle?.reports || []).length) {
    if (strict) {
      blockers.push(
        blocker("REPORT_ROWS_MISSING", "inconclusive", "no 压测报告产物 rows"),
      );
    } else {
      gaps.push("REPORT_ROWS_MISSING");
    }
  }
  if (!(bundle?.costs || []).length) {
    if (strict) {
      blockers.push(
        blocker("COST_ROWS_MISSING", "inconclusive", "no BYODB 成本估算 rows"),
      );
    } else {
      gaps.push("COST_ROWS_MISSING");
    }
  }
  return { blockers, gaps };
}

/**
 * Per-scenario verdict from the row's own numbers.
 * `scenario` uses 0-100 percentage points for errorRate, matching the table.
 */
export function deriveScenarioVerdict(scenario, spec, extra = {}) {
  const blockers = [...(extra.blockers || [])];
  const errorRate = asNumber(scenario?.errorRate);
  const p95 = asNumber(scenario?.p95);
  const p99 = asNumber(scenario?.p99);
  const slo = scenarioSlo(spec, scenario);

  if (errorRate === null) {
    blockers.push(
      blocker("ERROR_RATE_MISSING", "inconclusive", "错误率 is null"),
    );
  } else if (errorRate > spec.maxErrorRatePct) {
    blockers.push(
      blocker(
        "ERROR_RATE_EXCEEDED",
        "fail",
        `errorRate=${errorRate}% > Max_Error_Rate=${spec.maxErrorRatePct}%`,
      ),
    );
  }

  if (slo === null) {
    blockers.push(
      blocker("SLO_UNKNOWN", "inconclusive", "registry SLO_P95_MS is missing"),
    );
  } else if (p99 !== null && p99 > 2 * slo) {
    blockers.push(
      blocker("P99_OVER_2X_SLO", "aborted", `P99=${p99}ms > 2×SLO(${slo}ms)`),
    );
  } else if (p95 !== null && p95 > slo) {
    blockers.push(
      blocker("P95_OVER_SLO", "fail", `P95=${p95}ms > SLO(${slo}ms)`),
    );
  } else if (p95 === null || p99 === null) {
    blockers.push(
      blocker("LATENCY_MISSING", "inconclusive", "P95/P99 is null"),
    );
  }

  const correctness = String(scenario?.correctness || "").toLowerCase();
  if (correctness === "fail") {
    blockers.push(blocker("CORRECTNESS_FAIL", "fail", "row Correctness=fail"));
  } else if (correctness === "partial" || correctness === "skipped") {
    blockers.push(
      blocker(
        "CORRECTNESS_PARTIAL",
        "inconclusive",
        `row Correctness=${correctness}`,
      ),
    );
  }

  return { verdict: worstVerdict(blockers), blockers };
}

/**
 * Capacity claim from the ladder.
 * steps: [{ targetRps, repeats: ['pass','pass','fail'], verdict? }]
 * Definition (plan §3): X has 3/3 passes and X_next has >=2/3 fails.
 * Max_Sustainable_RPS is null until that failing successor exists.
 */
export function deriveCapacity(steps, options = {}) {
  const minRepeats = options.minRepeatsPerStep ?? 3;
  const minFails = options.minFailsPerStep ?? 2;
  const evaluated = (steps || [])
    .map((step) => {
      const targetRps = asNumber(step.targetRps ?? step.stepTargetRps);
      if (targetRps === null) return null;
      const repeats = Array.isArray(step.repeats)
        ? step.repeats.map((value) => String(value).toLowerCase())
        : step.verdict
          ? [String(step.verdict).toLowerCase()]
          : [];
      const count = repeats.length || Number(step.repeatCount || 0);
      const passes = repeats.filter((value) => value === "pass").length;
      const fails = repeats.filter(
        (value) => value === "fail" || value === "aborted",
      ).length;
      return {
        targetRps,
        count,
        passes,
        fails,
        allPass: count > 0 && passes === count,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.targetRps - b.targetRps);

  const issues = [];
  const passing = evaluated.filter((step) => step.allPass);
  const maxPassingRps = passing.length
    ? passing[passing.length - 1].targetRps
    : null;
  const atBoundary =
    evaluated.find((step) => step.targetRps === maxPassingRps) || null;
  const next =
    evaluated.find((step) => step.targetRps > (maxPassingRps ?? -Infinity)) ||
    null;

  for (const failed of evaluated.filter((step) => step.fails > 0)) {
    const above = passing.find((step) => step.targetRps > failed.targetRps);
    if (above) {
      issues.push(
        `non-monotonic ladder: ${above.targetRps} rps passed but lower ${failed.targetRps} rps failed`,
      );
    }
  }

  const boundaryQualified = Boolean(
    atBoundary && atBoundary.passes >= minRepeats,
  );
  const nextQualified = Boolean(
    next && next.count >= minRepeats && next.fails >= minFails,
  );
  const point = boundaryQualified && nextQualified && issues.length === 0;

  if (maxPassingRps !== null && !boundaryQualified) {
    issues.push(
      `boundary ${maxPassingRps} rps has ${atBoundary?.passes ?? 0}/${atBoundary?.count ?? 0} passing repeats; need ${minRepeats}/${minRepeats}`,
    );
  }
  if (maxPassingRps !== null && !next) {
    issues.push("no failing successor step yet; capacity is a lower bound");
  } else if (maxPassingRps !== null && !nextQualified) {
    issues.push(
      `next step ${next?.targetRps} rps has ${next?.fails ?? 0} failing repeats; need >=${minFails} of ${minRepeats}`,
    );
  }

  return {
    maxPassingRps,
    maxSustainableRps: point ? maxPassingRps : null,
    capacityBound: point ? "point" : "lower",
    interval:
      maxPassingRps === null
        ? null
        : [maxPassingRps, point ? next.targetRps : null],
    failingStepRps: next?.fails ? next.targetRps : null,
    issues,
  };
}

function isCanonicalV2Bundle(bundle) {
  return bundle?.run?.schemaVersion === "stress-evidence-v2";
}

function metricCompletenessBlockers(bundle) {
  const blockers = [];
  const metrics = bundle.metrics || [];
  if (metrics.length === 0) return blockers;
  for (const [index, metric] of metrics.entries()) {
    const label = metric.metric || `metrics[${index}]`;
    const status =
      typeof metric.collectionStatus === "string"
        ? metric.collectionStatus.trim().toLowerCase()
        : "";
    const rowStatus = String(metric.status || "")
      .trim()
      .toLowerCase();
    if (!status) {
      blockers.push(
        blocker(
          "METRIC_STATUS_MISSING",
          "inconclusive",
          `${label}: 采集状态 is missing`,
        ),
      );
    } else if (status !== "observed") {
      blockers.push(
        blocker(
          "METRIC_NOT_OBSERVED",
          "inconclusive",
          `${label}: 采集状态=${status}`,
        ),
      );
    } else if (rowStatus === "no_data" || rowStatus === "source_error") {
      blockers.push(
        blocker(
          "METRIC_NOT_OBSERVED",
          "inconclusive",
          `${label}: 状态=${rowStatus}`,
        ),
      );
    }
    if (!isFiniteNumber(metric.value)) {
      blockers.push(
        blocker(
          "METRIC_VALUE_MISSING",
          "inconclusive",
          `${label}: 数值 is missing`,
        ),
      );
    }
    if (!hasText(metric.queryReceipt ?? metric.query_receipt)) {
      blockers.push(
        blocker(
          "METRIC_QUERY_RECEIPT_MISSING",
          "inconclusive",
          `${label}: 查询收据 is missing`,
        ),
      );
    }
  }
  const observed = metrics.filter(
    (metric) =>
      String(metric.collectionStatus || "").toLowerCase() === "observed" &&
      isFiniteNumber(metric.value) &&
      hasText(metric.queryReceipt ?? metric.query_receipt),
  );
  const categories = [
    ["latency", /p50|p95|p99|latency|duration/],
    ["error", /error|failed|failure/],
    ["pool", /pool|database/],
    ["dropped", /dropped/],
  ];
  for (const [category, pattern] of categories) {
    if (
      !observed.some((metric) =>
        pattern.test(String(metric.metric || "").toLowerCase()),
      )
    ) {
      blockers.push(
        blocker(
          "METRIC_COVERAGE_MISSING",
          "inconclusive",
          `no observed ${category} metric window`,
        ),
      );
    }
  }
  return blockers;
}

function identity(value) {
  return hasText(value) ? String(value) : undefined;
}

function scenarioGrain(scenario, run) {
  return {
    scenarioId: identity(
      scenario.scenarioId ?? scenario.catalogId ?? scenario.scenario,
    ),
    mode: identity(scenario.mode ?? run.mode),
    repeat: identity(scenario.repeat ?? run.repeat),
    operation: identity(scenario.operationKey ?? scenario.operation),
    step: identity(
      scenario.stepTargetRps ??
        scenario.stepName ??
        scenario.step ??
        run.stepTargetRps ??
        run.stepName,
    ),
  };
}

function rowGrain(row, run) {
  return {
    scenarioId: identity(row.scenarioId ?? row.catalogId ?? row.scenario),
    mode: identity(row.mode ?? run.mode),
    repeat: identity(row.repeat ?? run.repeat),
    operation: identity(row.operationKey ?? row.operation),
    step: identity(
      row.stepTargetRps ??
        row.stepName ??
        row.step ??
        run.stepTargetRps ??
        run.stepName,
    ),
  };
}

function sameIdentity(expected, actual) {
  if (expected === undefined) return true;
  if (actual === undefined) return false;
  return actual === expected || actual === "all";
}

function grainMatches(grain, row) {
  return (
    sameIdentity(grain.scenarioId, row.scenarioId) &&
    sameIdentity(grain.mode, row.mode) &&
    sameIdentity(grain.repeat, row.repeat) &&
    sameIdentity(grain.operation, row.operation) &&
    sameIdentity(grain.step, row.step)
  );
}

function grainCompletenessBlockers(bundle) {
  const blockers = [];
  const run = bundle.run || {};
  const metrics = bundle.metrics || [];
  const checks = bundle.correctness || [];
  const categories = [
    ["latency", /p50|p95|p99|latency|duration/],
    ["error", /error|failed|failure/],
    ["pool", /pool|database/],
    ["dropped", /dropped/],
  ];
  for (const scenario of bundle.scenarios || []) {
    const grain = scenarioGrain(scenario, run);
    const label = [
      grain.scenarioId,
      grain.mode,
      grain.repeat,
      grain.operation,
      grain.step,
    ]
      .filter((value) => value !== undefined)
      .join("/");
    const grainMetrics = metrics.filter((metric) =>
      grainMatches(grain, rowGrain(metric, run)),
    );
    for (const [category, pattern] of categories) {
      const covered = grainMetrics.some(
        (metric) =>
          String(metric.collectionStatus || "").toLowerCase() === "observed" &&
          isFiniteNumber(metric.value) &&
          hasText(metric.queryReceipt ?? metric.query_receipt) &&
          pattern.test(String(metric.metric || "").toLowerCase()),
      );
      if (!covered) {
        blockers.push(
          blocker(
            "GRAIN_METRIC_MISSING",
            "inconclusive",
            `${label || "scenario"}: no observed ${category} metric for this grain`,
          ),
        );
      }
    }
    const grainChecks = checks.filter((check) =>
      grainMatches(grain, rowGrain(check, run)),
    );
    if (grainChecks.length === 0) {
      blockers.push(
        blocker(
          "GRAIN_CORRECTNESS_MISSING",
          "inconclusive",
          `${label || "scenario"}: no correctness check for this grain`,
        ),
      );
    }
  }
  return blockers;
}

function parseTime(value) {
  if (!hasText(value)) return null;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function timeCompletenessBlockers(bundle) {
  const blockers = [];
  const run = bundle.run || {};
  const start = parseTime(run.startTime);
  const end = parseTime(run.endTime);
  const windowStart = parseTime(run.windowStart);
  const windowEnd = parseTime(run.windowEnd);
  if (
    start === null ||
    end === null ||
    windowStart === null ||
    windowEnd === null
  ) {
    blockers.push(
      blocker(
        "RUN_TIME_MISSING",
        "inconclusive",
        "canonical v2 requires valid run start/end and measurement windows",
      ),
    );
    return blockers;
  }
  if (start >= end) {
    blockers.push(
      blocker(
        "RUN_TIME_ORDER_INVALID",
        "inconclusive",
        "startTime must be < endTime",
      ),
    );
  }
  if (windowStart >= windowEnd) {
    blockers.push(
      blocker(
        "WINDOW_TIME_ORDER_INVALID",
        "inconclusive",
        "windowStart must be < windowEnd",
      ),
    );
  }
  if (windowStart < start || windowEnd > end) {
    blockers.push(
      blocker(
        "WINDOW_OUTSIDE_RUN",
        "inconclusive",
        "measurement window must be inside the run",
      ),
    );
  }
  for (const [kind, rows, labelFor] of [
    ["metric", bundle.metrics || [], (row) => row.metric],
    ["report", bundle.reports || [], (row) => row.reportKey ?? row.report_key],
  ]) {
    for (const [index, row] of rows.entries()) {
      const rawStart = row.windowStart ?? row.window_start;
      const rawEnd = row.windowEnd ?? row.window_end;
      if (!hasText(rawStart) && !hasText(rawEnd)) continue;
      const rowStart = parseTime(rawStart);
      const rowEnd = parseTime(rawEnd);
      const label = `${kind}s[${labelFor(row) || index}]`;
      if (rowStart === null || rowEnd === null || rowStart >= rowEnd) {
        blockers.push(
          blocker(
            kind === "metric"
              ? "METRIC_WINDOW_INVALID"
              : "REPORT_WINDOW_INVALID",
            "inconclusive",
            `${label}: window must be ordered and complete`,
          ),
        );
        continue;
      }
      if (rowStart < windowStart || rowEnd > windowEnd) {
        blockers.push(
          blocker(
            kind === "metric"
              ? "METRIC_WINDOW_INVALID"
              : "REPORT_WINDOW_INVALID",
            "inconclusive",
            `${label}: window must be contained in the measurement window`,
          ),
        );
      }
    }
  }
  return blockers;
}

function reportCompletenessBlockers(bundle) {
  const blockers = [];
  for (const [index, report] of (bundle.reports || []).entries()) {
    const missing = [];
    if (!hasText(report.reportKey ?? report.report_key))
      missing.push("Report_Key");
    if (!hasText(report.queryReceipt ?? report.query_receipt))
      missing.push("Query_Receipt");
    if (!hasText(report.sourceTables ?? report.source_tables))
      missing.push("Source_Tables");
    if (!hasText(report.dataHash ?? report.data_hash))
      missing.push("Data_Hash");
    const generatedAt = report.generatedAt ?? report.generated_at;
    if (!hasText(generatedAt) || !Number.isFinite(Date.parse(generatedAt))) {
      missing.push("Generated_At");
    }
    if (!hasText(report.uri)) missing.push("URI");
    if (String(report.status || "").toLowerCase() !== "ok")
      missing.push("Status=ok");
    if (missing.length) {
      blockers.push(
        blocker(
          "REPORT_EVIDENCE_INCOMPLETE",
          "inconclusive",
          `reports[${index}] missing ${missing.join(", ")}`,
        ),
      );
    }
  }
  return blockers;
}

function costCompletenessBlockers(bundle, coverage) {
  const blockers = [];
  if ((bundle.costs || []).length && coverage !== "full") {
    blockers.push(
      blocker(
        "COST_COVERAGE_PARTIAL",
        "inconclusive",
        "canonical v2 requires full DB/app-node/loadgen/ops cost coverage",
      ),
    );
  }
  for (const [index, cost] of (bundle.costs || []).entries()) {
    const label =
      cost.costComponent ?? cost.cost_component ?? `costs[${index}]`;
    const estimatedAt = cost.estimatedAt ?? cost.estimated_at;
    const estimatedAtValid =
      hasText(estimatedAt) && Number.isFinite(Date.parse(estimatedAt));
    if (
      !isFiniteNumber(cost.estAmount ?? cost.est_amount) ||
      !estimatedAtValid
    ) {
      blockers.push(
        blocker(
          "COST_ESTIMATE_INCOMPLETE",
          "inconclusive",
          `${label}: needs Est_Amount and Estimated_At`,
        ),
      );
    }
  }
  return blockers;
}

function specVersionBlockers(bundle) {
  const blockers = [];
  const runSpec = hasText(bundle.run?.specVersion)
    ? String(bundle.run.specVersion)
    : null;
  const registrySpecRaw =
    bundle.registry?.specVersion ?? bundle.registry?.spec_version;
  const registrySpec = hasText(registrySpecRaw)
    ? String(registrySpecRaw)
    : null;
  if (!runSpec) {
    blockers.push(
      blocker(
        "SPEC_VERSION_MISSING",
        "inconclusive",
        "run Spec_Version is missing",
      ),
    );
  }
  if (!registrySpec) {
    blockers.push(
      blocker(
        "SPEC_VERSION_MISSING",
        "inconclusive",
        "registry Spec_Version is missing",
      ),
    );
  } else if (runSpec && registrySpec !== runSpec) {
    blockers.push(
      blocker(
        "SPEC_VERSION_MISMATCH",
        "inconclusive",
        `run Spec_Version=${runSpec} != registry Spec_Version=${registrySpec}`,
      ),
    );
  }
  for (const [index, scenario] of (bundle.scenarios || []).entries()) {
    const label =
      scenario.scenarioId || scenario.catalogId || `scenarios[${index}]`;
    const scenarioSpecRaw = scenario.specVersion ?? scenario.spec_version;
    const scenarioSpec = hasText(scenarioSpecRaw)
      ? String(scenarioSpecRaw)
      : null;
    if (!scenarioSpec) {
      blockers.push(
        blocker(
          "SPEC_VERSION_MISSING",
          "inconclusive",
          `${label}: Spec_Version is missing`,
        ),
      );
    } else if (runSpec && scenarioSpec !== runSpec) {
      blockers.push(
        blocker(
          "SPEC_VERSION_MISMATCH",
          "inconclusive",
          `${label}: Spec_Version=${scenarioSpec} != run Spec_Version=${runSpec}`,
        ),
      );
    }
  }
  const scopedRows = [
    ["metric", bundle.metrics || [], (row) => row.metric],
    ["correctness", bundle.correctness || [], (row) => row.checkKey],
    [
      "cost",
      bundle.costs || [],
      (row) => row.costComponent ?? row.cost_component,
    ],
    ["report", bundle.reports || [], (row) => row.reportKey ?? row.report_key],
  ];
  for (const [kind, rows, labelFor] of scopedRows) {
    for (const [index, row] of rows.entries()) {
      const scenarioRef = row.scenarioId ?? row.catalogId ?? row.scenario;
      const scoped =
        hasText(scenarioRef) && String(scenarioRef).toLowerCase() !== "all";
      const specRaw = row.specVersion ?? row.spec_version;
      const spec = hasText(specRaw) ? String(specRaw) : null;
      const label = `${kind}s[${labelFor(row) || index}]`;
      if (scoped && !spec) {
        blockers.push(
          blocker(
            "SPEC_VERSION_MISSING",
            "inconclusive",
            `${label}: scenario-scoped row needs Spec_Version`,
          ),
        );
      } else if (spec && runSpec && spec !== runSpec) {
        blockers.push(
          blocker(
            "SPEC_VERSION_MISMATCH",
            "inconclusive",
            `${label}: Spec_Version=${spec} != run Spec_Version=${runSpec}`,
          ),
        );
      }
    }
  }
  return blockers;
}

/**
 * Plan the whole bundle gate. Pure: no network, no writes.
 *
 * bundle.run.rowKind is `summary` (umbrella) or `step`. Umbrella rows own the
 * 7-row evidence completeness, cleanup, cost, and capacity claim; step rows own
 * only their own numbers.
 */
export function planBundleGate(bundle, options = {}) {
  const spec = resolveRegistrySpec(bundle);
  const run = bundle.run || {};
  const umbrella = (run.rowKind || "summary") !== "step";
  const strict = isCanonicalV2Bundle(bundle);
  const rowState = evidenceRowState(bundle, { umbrella, strict });
  const cost = evaluateCostCoverage(bundle.costs || [], options.cost || {});
  const globalBlockers = [
    ...explicitGuardrailBlockers(bundle),
    ...droppedIterationsBlockers(bundle, bundle.scenarios || []),
    ...cleanupBlockers(bundle, { umbrella, strict }),
    ...correctnessBlockers(bundle, { umbrella, strict }),
    ...v2Blockers(bundle, spec),
    ...(strict
      ? [
          ...metricCompletenessBlockers(bundle),
          ...grainCompletenessBlockers(bundle),
          ...timeCompletenessBlockers(bundle),
          ...reportCompletenessBlockers(bundle),
          ...costCompletenessBlockers(bundle, cost.coverage),
          ...specVersionBlockers(bundle),
        ]
      : []),
    ...rowState.blockers,
  ];
  const gaps = rowState.gaps.slice();
  if ((umbrella || strict) && !hasText(run.environmentBaseline)) {
    globalBlockers.push(
      blocker(
        "ENVIRONMENT_BASELINE_MISSING",
        "inconclusive",
        "环境基线 is empty",
      ),
    );
  }
  if (strict && !hasText(run.environment)) {
    globalBlockers.push(
      blocker("ENVIRONMENT_MISSING", "inconclusive", "run 环境 is missing"),
    );
  }
  if (strict && !hasText(run.codeVersion)) {
    globalBlockers.push(
      blocker(
        "CODE_VERSION_MISSING",
        "inconclusive",
        "run 代码版本 is missing",
      ),
    );
  }
  // #3: a ladder summary's correctness is the worst of its children, never a
  // hand-entered `pass` that contradicts a partial child.
  if (umbrella && Array.isArray(bundle.ladder)) {
    const derived = deriveCorrectness([], bundle.ladder);
    if (derived === "fail") {
      globalBlockers.push(
        blocker(
          "CHILD_CORRECTNESS_FAIL",
          "fail",
          "a ladder step reports Correctness=fail",
        ),
      );
    } else if (derived === "partial") {
      globalBlockers.push(
        blocker(
          "CHILD_CORRECTNESS_PARTIAL",
          "inconclusive",
          "a ladder step reports Correctness=partial",
        ),
      );
    }
  }
  if (
    umbrella &&
    run.rowKind === "summary" &&
    isFiniteNumber(run.totalRequests)
  ) {
    gaps.push("SUMMARY_TOTALS_PRESENT");
  }

  const scenarios = (bundle.scenarios || []).map((scenario, index) => {
    const derived = deriveScenarioVerdict(scenario, spec, {
      blockers: globalBlockers,
    });
    return { index, verdict: derived.verdict, blockers: derived.blockers };
  });

  const blockers = globalBlockers.slice();
  for (const scenario of scenarios) {
    for (const item of scenario.blockers) {
      if (!blockers.includes(item)) blockers.push(item);
    }
  }

  let capacity = null;
  const isBreakpoint =
    String(run.testType || "").toLowerCase() === "breakpoint" ||
    run.profile === "breakpoint";
  if (isBreakpoint) {
    const ladder =
      bundle.ladder ||
      (bundle.scenarios || []).map((scenario) => ({
        targetRps: scenario.stepTargetRps ?? scenario.targetRps,
        verdict: scenario.verdict,
        repeatCount: scenario.repeatCount,
        repeats: scenario.repeats,
      }));
    capacity = deriveCapacity(ladder, options.capacity || {});
    if (
      umbrella &&
      capacity.maxPassingRps !== null &&
      capacity.maxSustainableRps === null
    ) {
      capacity.issues.push(
        "no closed ladder (failing step + repeats): report ≥N rps as a lower bound, never as capacity",
      );
    }
  }

  let verdict = worstVerdict(blockers);
  if (
    verdict === "pass" &&
    isBreakpoint &&
    umbrella &&
    capacity &&
    capacity.maxPassingRps !== null &&
    capacity.maxSustainableRps === null
  ) {
    verdict = "capacity_only";
  }

  return {
    verdict,
    gate: verdict === "pass" || verdict === "capacity_only" ? "pass" : verdict,
    blockers,
    gaps,
    scenarios,
    capacity,
    cost,
    spec,
  };
}

/**
 * Correctness rollup for summary rows: worst child wins.
 * `fail` > `partial` > `pass`; no children at all is `skipped`, never `pass`.
 */
export function deriveCorrectness(checks, scenarioRows = []) {
  const statuses = [];
  for (const check of checks || []) {
    statuses.push(String(check.status || "").toLowerCase());
  }
  for (const row of scenarioRows || []) {
    const value = String(row.correctness || "").toLowerCase();
    if (value) statuses.push(value);
  }
  if (statuses.some((status) => status === "fail")) return "fail";
  if (statuses.some((status) => status === "partial" || status === "skipped"))
    return "partial";
  const evaluated = statuses.filter((status) => status === "pass");
  return evaluated.length ? "pass" : "skipped";
}

/**
 * Ladder totals reconciliation (#15). Umbrella rows must not publish a request
 * total or latency rollup: those are per-step facts. The only admissible total
 * is the sum of step rows; any umbrella figure is lifecycle overhead and must
 * be explained, never summed into the step totals.
 */
export function reconcileLadderTotals({
  umbrellaTotal,
  ladderSummaryTotal,
  steps = [],
}) {
  const stepSum = (steps || []).reduce((sum, step) => {
    const value = asNumber(step.requests ?? step.totalRequests);
    return sum + (value ?? 0);
  }, 0);
  const report = {
    stepTotalSum: stepSum,
    umbrellaTotal: asNumber(umbrellaTotal),
    ladderSummaryTotal: asNumber(ladderSummaryTotal),
    differences: {},
    admissibleTotal: stepSum,
    issues: [],
  };
  if (report.umbrellaTotal !== null) {
    report.differences.umbrellaMinusSteps = report.umbrellaTotal - stepSum;
    report.issues.push(
      "umbrella 总请求数 must be null; keep the raw lifecycle count in 备注 and the step sum as the only total",
    );
  }
  if (report.ladderSummaryTotal !== null) {
    report.differences.summaryMinusSteps = report.ladderSummaryTotal - stepSum;
  }
  if (
    report.ladderSummaryTotal !== null &&
    report.ladderSummaryTotal !== stepSum
  ) {
    report.issues.push(
      "ladder summary requests must equal the sum of step rows or be null",
    );
  }
  return report;
}

/**
 * A human may lower the derived verdict, never raise it.
 * Strictness: pass < capacity_only < inconclusive < fail < aborted.
 */
export function applyHumanVerdict(derivedVerdict, humanVerdict) {
  if (!humanVerdict) return { verdict: derivedVerdict, downgraded: false };
  if (!(humanVerdict in VERDICT_RANK)) {
    throw new Error(`unknown verdict: ${humanVerdict}`);
  }
  if (VERDICT_RANK[humanVerdict] < VERDICT_RANK[derivedVerdict]) {
    throw new Error(
      `verdict upgrade rejected: evidence derives ${derivedVerdict}, human supplied ${humanVerdict}`,
    );
  }
  return { verdict: humanVerdict, downgraded: humanVerdict !== derivedVerdict };
}

// ---------------------------------------------------------------------------
// Cost coverage
// ---------------------------------------------------------------------------

export function normalizeCostComponent(value) {
  const text = String(value || "other")
    .toLowerCase()
    .trim();
  const aliases = {
    database: "db",
    rds: "db",
    cnpg: "db",
    "customer-db": "db",
    app: "appnode",
    "app-node": "appnode",
    nodes: "appnode",
    loadgen: "loadgen",
    "load-generator": "loadgen",
    ec2: "loadgen",
    observability: "observability",
    signoz: "observability",
    ops: "ops",
    provisioning: "ops",
  };
  return COST_COMPONENTS.includes(text) ? text : aliases[text] || "other";
}

function convertAmount(amount, from, to, row, fx) {
  if (from === to) return { value: amount };
  const direct = row.fxRate ?? fx.rates?.[`${from}:${to}`];
  if (!isFiniteNumber(direct)) {
    return { value: null, issue: `no FX rate for ${from}->${to}` };
  }
  return { value: amount * Number(direct), rate: Number(direct) };
}

/**
 * Full coverage means: every present component has a numeric Actual_Amount,
 * all four core components (db/appnode/loadgen/ops) have rows, and every
 * non-base currency has an explicit FX rate. Anything less is `partial`, and
 * Actual_Run_Cost must stay null.
 */
export function evaluateCostCoverage(costs, options = {}) {
  const baseCurrency = options.baseCurrency || "CNY";
  const fx = { rates: {}, ...options.fx };
  const issues = [];
  const components = {};
  let actualRunCost = null;

  for (const cost of costs || []) {
    const component = normalizeCostComponent(
      cost.costComponent ?? cost.component,
    );
    const currency = cost.currency || baseCurrency;
    const actual = asNumber(cost.actualAmount);
    if (!components[component])
      components[component] = { rows: 0, amount: 0, currencies: [] };
    components[component].rows += 1;
    components[component].currencies.push(currency);
    if (actual === null) {
      issues.push(`${component}: Actual_Amount is null`);
      continue;
    }
    if (String(currency) !== String(baseCurrency)) {
      const rate = asNumber(cost.fxRate);
      const rateAsOf = Date.parse(String(cost.fxAsOf ?? cost.fx_as_of ?? ""));
      if (rate === null || rate <= 0) {
        issues.push(
          `${component}: non-base currency requires a positive finite FX_Rate`,
        );
        continue;
      }
      if (!Number.isFinite(rateAsOf)) {
        issues.push(`${component}: non-base currency requires FX_AsOf`);
        continue;
      }
    }
    const converted = convertAmount(actual, currency, baseCurrency, cost, fx);
    if (converted.value === null) {
      issues.push(`${component}: ${converted.issue}`);
      continue;
    }
    components[component].amount += converted.value;
  }

  for (const component of CORE_COST_COMPONENTS) {
    if (!components[component])
      issues.push(`missing core component ${component}`);
  }

  const coverage = issues.length === 0 ? "full" : "partial";
  if (coverage === "full") {
    actualRunCost = Object.values(components).reduce(
      (sum, item) => sum + item.amount,
      0,
    );
  }
  return { coverage, actualRunCost, baseCurrency, components, issues };
}

/** Cost anomaly is only meaningful when coverage is full and Est is numeric. */
export function evaluateCostAnomaly({
  coverage,
  actualRunCost,
  estRunCost,
  threshold = 1.5,
}) {
  if (coverage !== "full") return null;
  if (!isFiniteNumber(actualRunCost) || !isFiniteNumber(estRunCost))
    return null;
  return Number(actualRunCost) > threshold * Number(estRunCost);
}

/** Est_Run_Cost is a pre-run value: it must be timestamped before the run. */
export function assertPreRunEstimate({ estAmount, estimatedAt, runStartTime }) {
  if (!isFiniteNumber(estAmount)) return { ok: true, code: null };
  if (!estimatedAt) return { ok: false, code: "EST_RECORDED_AT_MISSING" };
  const estTime = Date.parse(String(estimatedAt));
  const startTime = Date.parse(String(runStartTime));
  if (!Number.isFinite(estTime))
    return { ok: false, code: "EST_RECORDED_AT_INVALID" };
  if (!Number.isFinite(startTime))
    return { ok: false, code: "RUN_START_MISSING" };
  if (estTime > startTime) return { ok: false, code: "EST_BACKFILLED" };
  return { ok: true, code: null };
}

export const __internal = {
  CORE_COST_COMPONENTS,
  withLegacyDimensions,
  worstVerdict,
};
