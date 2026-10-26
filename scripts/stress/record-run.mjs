#!/usr/bin/env node
// Upsert a stress-run evidence bundle into the Teable evidence base.
// Idempotent by 证据键: a rerun updates the existing row instead of creating a duplicate.
// Usage:
//   BASE_URL=https://staging.teable.ai TEABLE_TOKEN=... \
//     node scripts/stress/record-run.mjs --bundle run-bundle.json [--dry-run]
// Bundle contract: stress-evidence-v2 is the default for new bundles. Pass
// run.schemaVersion=stress-evidence-v1 or --key-format v1 only for migration reruns.
// All table IDs come from evidence-schema.mjs and may be overridden there via
// EVIDENCE_<TABLE>_TABLE_ID. --no-write-gate-fields is only for staged rollout
// against a base that has not received the canonical v2 columns yet.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  applyHumanVerdict,
  assertPreRunEstimate,
  buildEvidenceKey,
  evaluateCostAnomaly,
  normalizeCostComponent,
  planBundleGate,
} from "./evidence-gate.mjs";
import { resolveEvidenceSchema } from "./evidence-schema.mjs";
import { dirname, resolve } from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith("--")) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const bundlePath = args.bundle ? resolve(args.bundle) : "";
if (!bundlePath) {
  console.error("Missing --bundle");
  process.exit(2);
}

const baseUrl = (args["base-url"] || process.env.BASE_URL || "").replace(
  /\/+$/,
  "",
);
const token = process.env.TEABLE_TOKEN || process.env.TOKEN || "";
const evidenceSchema = resolveEvidenceSchema({ baseId: args["base-id"] });
const evidenceBaseId = evidenceSchema.baseId;
const TABLES = evidenceSchema.tableIds;
// Select fields are single-select enums. By default an unknown choice is a hard
// error (typecast:false); --typecast-selects opts into Teable's typecast so a
// genuinely new choice can be stored. That flag can create new select options
// in the remote field metadata, so it is never enabled implicitly.
const typecastSelects =
  args["typecast-selects"] === true ||
  /^(1|true|yes)$/i.test(process.env.TYPECAST_SELECTS || "");
const dryRun = Boolean(args["dry-run"]);
const outPath = args.out ? resolve(args.out) : "";

if (!dryRun && (!baseUrl || !token)) {
  console.error("BASE_URL and TEABLE_TOKEN are required (or use --dry-run).");
  process.exit(2);
}

const bundle = JSON.parse(await readFile(bundlePath, "utf8"));
if (!bundle.run?.runId) {
  console.error("Bundle run.runId is required.");
  process.exit(2);
}

const bundleSchema = bundle.run.schemaVersion || "stress-evidence-v2";
const keyFormat =
  args["key-format"] || (bundleSchema === "stress-evidence-v1" ? "v1" : "v2");
const run = bundle.run;
function supplied(value) {
  return value === undefined || value === null || value === ""
    ? undefined
    : value;
}
// Gate mode:
//   auto     enforce for canonical v2 keys, off for effective v1 migration
//            keys so an in-flight rerun stays byte-identical
//   report   compute and print, never write a different verdict
//   enforce  derive the verdict; a human may keep a stricter verdict, never a
//            looser one
//   off      legacy behaviour
const gateArg = String(args.gate || "auto").toLowerCase();
const gateMode =
  gateArg === "auto" ? (keyFormat === "v2" ? "enforce" : "off") : gateArg;
if (!["off", "report", "enforce"].includes(gateMode)) {
  console.error(`--gate must be auto|report|enforce|off (got ${gateArg})`);
  process.exit(2);
}
const gatePlan =
  gateMode === "off"
    ? null
    : planBundleGate(
        { ...bundle, run: { ...bundle.run, schemaVersion: bundleSchema } },
        {
          cost: {
            baseCurrency:
              args["base-currency"] ||
              process.env.COST_BASE_CURRENCY ||
              bundle.run.costBaseCurrency ||
              "CNY",
          },
        },
      );
if (keyFormat === "v2") {
  const missing = ["startTime", "endTime", "windowStart", "windowEnd"].filter(
    (name) => !run[name] || !Number.isFinite(Date.parse(String(run[name]))),
  );
  for (const name of ["environment", "codeVersion", "environmentBaseline"]) {
    if (!supplied(run[name])) missing.push(name);
  }
  if (missing.length) {
    console.error(
      `canonical v2 requires environment, codeVersion, environmentBaseline, startTime, endTime, windowStart, and windowEnd; missing/invalid: ${missing.join(", ")}`,
    );
    process.exit(2);
  }
  const start = Date.parse(run.startTime);
  const end = Date.parse(run.endTime);
  const windowStart = Date.parse(run.windowStart);
  const windowEnd = Date.parse(run.windowEnd);
  if (start >= end) {
    console.error("canonical v2 requires startTime < endTime");
    process.exit(2);
  }
  if (windowStart >= windowEnd) {
    console.error("canonical v2 requires windowStart < windowEnd");
    process.exit(2);
  }
  if (windowStart < start || windowEnd > end) {
    console.error(
      "canonical v2 requires the measurement window to be contained in the run",
    );
    process.exit(2);
  }
}
if (keyFormat !== "v1" && keyFormat !== "v2") {
  console.error(`--key-format must be v1 or v2 (got ${keyFormat})`);
  process.exit(2);
}
const writeGateFields =
  args["write-gate-fields"] === true ||
  (keyFormat === "v2" && args["no-write-gate-fields"] !== true);
const verdictMismatches = [];
function decideVerdict(derived, human, label) {
  if (gateMode !== "enforce") {
    if (human && derived && human !== derived) {
      verdictMismatches.push({
        label,
        derived,
        human,
        applied: human || derived,
      });
    }
    return human || derived;
  }
  try {
    return applyHumanVerdict(derived, human).verdict;
  } catch (error) {
    console.error(`${label}: ${error.message}`);
    process.exit(1);
  }
}

const tableMetaCache = new Map();
const seenKeys = new Set();
const summary = {
  runId: bundle.run.runId,
  schemaVersion: bundleSchema,
  keyFormat,
  evidenceSchema: { baseId: evidenceBaseId, tableIds: TABLES },
  records: [],
  created: 0,
  updated: 0,
  dryRun,
  warnings: [],
};
if (gatePlan) {
  summary.gate = {
    mode: gateMode,
    derivedVerdict: gatePlan.verdict,
    blockers: gatePlan.blockers,
    gaps: gatePlan.gaps,
    capacity: gatePlan.capacity,
    cost: gatePlan.cost,
    mismatches: verdictMismatches,
  };
}
if (gatePlan && gateMode === "enforce") {
  for (const [index, cost] of (bundle.costs || []).entries()) {
    const check = assertPreRunEstimate({
      estAmount: cost.estAmount,
      estimatedAt: cost.estimatedAt,
      runStartTime: bundle.run.startTime,
    });
    if (!check.ok) {
      console.error(
        `costs[${index}] (${cost.costComponent || "component"}): Est_Run_Cost must be pre-run (${check.code})`,
      );
      process.exit(1);
    }
  }
}
const runVerdict =
  gateMode === "report"
    ? bundle.run.verdict || "inconclusive"
    : gatePlan
      ? decideVerdict(gatePlan.verdict, bundle.run.verdict, "run")
      : bundle.run.verdict || "inconclusive";
if (gatePlan && gateMode === "enforce") {
  if (
    gatePlan.cost.coverage !== "full" &&
    bundle.run.actualRunCost !== undefined
  ) {
    summary.warnings.push(
      "Actual_Run_Cost dropped: Cost_Coverage=partial (one or more component Actual_Amount is null)",
    );
  }
}

async function request(method, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(
      `${method} ${path} -> ${res.status}: ${String(text).slice(0, 500)}`,
    );
  }
  return json;
}

async function getTableMeta(tableId) {
  if (tableMetaCache.has(tableId)) return tableMetaCache.get(tableId);
  const fields = await request(
    "GET",
    `/api/table/${encodeURIComponent(tableId)}/field`,
  );
  const map = new Map();
  for (const field of fields || []) {
    map.set(field.name, {
      id: field.id,
      type: field.type,
      choices: (field.options?.choices || []).map((choice) => choice.name),
    });
  }
  tableMetaCache.set(tableId, map);
  return map;
}

async function getFields(tableId) {
  const meta = await getTableMeta(tableId);
  const map = new Map();
  for (const [name, field] of meta) map.set(name, field.id);
  return map;
}

async function validateSelects(tableId, values) {
  const meta = await getTableMeta(tableId);
  const invalid = [];
  for (const [name, value] of Object.entries(values)) {
    const field = meta.get(name);
    if (
      !field ||
      field.type !== "singleSelect" ||
      value === undefined ||
      value === null
    )
      continue;
    if (!field.choices.length) continue;
    if (!field.choices.includes(String(value))) {
      invalid.push({ field: name, value, allowed: field.choices });
    }
  }
  if (invalid.length && !typecastSelects) {
    const detail = invalid
      .map(
        (item) =>
          `${item.field}=${JSON.stringify(item.value)} (allowed: ${item.allowed.join(", ")})`,
      )
      .join("; ");
    throw new Error(
      `${tableId} has unknown single-select values: ${detail}. ` +
        "Fix the bundle or pass --typecast-selects (which may add options to the remote field).",
    );
  }
  return invalid;
}

function filterFor(fieldId, value) {
  return JSON.stringify({
    conjunction: "and",
    filterSet: [{ fieldId, operator: "is", value }],
  });
}

async function findRecordEntry(tableId, keyField, keyValue) {
  const fields = await getFields(tableId);
  const fieldId = fields.get(keyField);
  if (!fieldId) throw new Error(`Field ${keyField} not found in ${tableId}`);
  const path =
    `/api/table/${encodeURIComponent(tableId)}/record?take=1&filter=` +
    encodeURIComponent(filterFor(fieldId, keyValue));
  try {
    const result = await request("GET", path);
    return result?.records?.[0] || null;
  } catch (error) {
    // Some deployments reject name-based filters; fall back to a bounded scan.
    const fallback = await request(
      "GET",
      `/api/table/${encodeURIComponent(tableId)}/record?take=1000`,
    );
    return (
      (fallback?.records || []).find(
        (row) => String(row.fields?.[keyField]) === String(keyValue),
      ) || null
    );
  }
}

async function findRecord(tableId, keyField, keyValue) {
  const record = await findRecordEntry(tableId, keyField, keyValue);
  return record?.id || null;
}

function summaryRecord(tableId, keyField, keyValue, values, extra = {}) {
  const evidenceKey = values?.证据键 ?? keyValue;
  return {
    tableId,
    keyField,
    keyValue: evidenceKey,
    ...(evidenceKey === keyValue ? {} : { lookupKey: keyValue }),
    ...extra,
    ...(values === undefined ? {} : { values }),
  };
}

async function upsert(tableId, keyField, keyValue, values) {
  const keyIdentity = `${tableId}/${keyValue}`;
  if (seenKeys.has(keyIdentity)) {
    throw new Error(
      `Duplicate evidence key in bundle: ${keyIdentity}. ` +
        "Distinguish the rows with mode/repeat/operationKey or a distinct Run_ID.",
    );
  }
  seenKeys.add(keyIdentity);
  let typecast = false;
  if (!dryRun) {
    const invalid = await validateSelects(tableId, values);
    if (invalid.length) {
      typecast = true;
      summary.warnings.push(
        `${tableId}/${keyValue}: typecast-selects accepted ${invalid
          .map((item) => item.field)
          .join(", ")}`,
      );
    }
  }
  if (dryRun) {
    summary.records.push(
      summaryRecord(tableId, keyField, keyValue, values, { existing: null }),
    );
    return `dry_${summary.records.length}`;
  }
  const existing = await findRecord(tableId, keyField, keyValue);
  if (existing) {
    await request(
      "PATCH",
      `/api/table/${encodeURIComponent(tableId)}/record/${encodeURIComponent(existing)}`,
      {
        fieldKeyType: "name",
        typecast,
        record: { fields: values },
      },
    );
    summary.updated++;
    summary.records.push({
      tableId,
      keyField,
      keyValue,
      id: existing,
      action: "updated",
    });
    return existing;
  }
  const created = await request(
    "POST",
    `/api/table/${encodeURIComponent(tableId)}/record`,
    {
      fieldKeyType: "name",
      typecast,
      records: [{ fields: values }],
    },
  );
  summary.created++;
  const id = created?.records?.[0]?.id;
  summary.records.push({ tableId, keyField, keyValue, id, action: "created" });
  return id;
}

function link(recordId) {
  return recordId ? [{ id: recordId }] : undefined;
}

function compact(values) {
  const out = {};
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function iso(value, fallback) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}
function invalidWindow(label, start, end, boundStart, boundEnd) {
  const hasStart = supplied(start) !== undefined;
  const hasEnd = supplied(end) !== undefined;
  if (!hasStart && !hasEnd) return null;
  if (!hasStart || !hasEnd)
    return `${label} requires both windowStart and windowEnd`;
  const startMs = Date.parse(String(start));
  const endMs = Date.parse(String(end));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return `${label} has an invalid window`;
  }
  if (startMs >= endMs) return `${label} requires windowStart < windowEnd`;
  const boundStartMs = Date.parse(String(boundStart));
  const boundEndMs = Date.parse(String(boundEnd));
  if (
    Number.isFinite(boundStartMs) &&
    Number.isFinite(boundEndMs) &&
    (startMs < boundStartMs || endMs > boundEndMs)
  ) {
    return `${label} window must be contained in the run window`;
  }
  return null;
}

function numericOrNull(value) {
  const candidate = supplied(value);
  if (
    candidate === undefined ||
    typeof candidate === "boolean" ||
    typeof candidate === "object"
  ) {
    return null;
  }
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}

const nowIso = new Date().toISOString();

const runKey = buildEvidenceKey(
  "run",
  { runId: run.runId },
  { format: keyFormat },
);
const effectiveActualRunCost =
  gatePlan && gateMode === "enforce"
    ? gatePlan.cost.coverage === "full"
      ? gatePlan.cost.actualRunCost
      : null
    : run.actualRunCost;
const effectiveCostAnomaly =
  gateMode === "enforce" && gatePlan
    ? evaluateCostAnomaly({
        coverage: gatePlan.cost.coverage,
        actualRunCost: gatePlan.cost.actualRunCost ?? effectiveActualRunCost,
        estRunCost: run.estimatedRunCost,
      })
    : run.costAnomaly === undefined
      ? undefined
      : Boolean(run.costAnomaly);
let parentRunRecordId = run.parentRunRecordId || null;
if (!dryRun && !parentRunRecordId && run.parentRunId) {
  parentRunRecordId = await findRecord(TABLES.run, "运行ID", run.parentRunId);
}
const runFields = compact({
  运行ID: run.runId,
  环境: run.environment || (keyFormat === "v1" ? "staging" : ""),
  测试类型: run.testType || "load",
  场景集: run.scenarioSet || "",
  状态: run.status || "success",
  判定: runVerdict,
  负载模型: run.loadModel || "open_arrival",
  目标RPS: run.targetRps,
  峰值RPS: run.peakRps,
  总请求数: run.totalRequests,
  成功率百分比: run.successRate,
  P95毫秒: run.p95,
  P99毫秒: run.p99,
  错误预算消耗百分比: run.errorBudgetBurn,
  开始时间: iso(run.startTime, nowIso),
  结束时间: iso(run.endTime, nowIso),
  窗口开始: iso(run.windowStart, iso(run.startTime, nowIso)),
  窗口结束: iso(run.windowEnd, iso(run.endTime, nowIso)),
  代码版本: run.codeVersion || "",
  环境基线: run.environmentBaseline || "",
  结论: run.conclusion || "",
  报告链接: run.reportUrl || "",
  原始产物链接: run.artifactUrl || "",
  瓶颈摘要: run.bottleneckSummary || "",
  采集状态: run.collectionStatus || "observed",
  口径版本: bundleSchema,
  证据键: runKey,
  备注: run.notes || "",
  分类: run.category || "core",
  AI预算USD: run.aiBudgetUsd,
  实际AI成本USD: run.actualAiCostUsd,
  总Token数: run.totalTokens,
  预算状态:
    run.budgetStatus || (run.category === "ai" ? "unknown" : "not_applicable"),
  数据库规格: run.dbSpec,
  Spec_Version: run.specVersion,
  BYODB_Spaces: run.byodbSpaces,
  DB_Physical_Count: run.dbPhysicalCount,
  BYODB_Traffic_Share: run.byodbTrafficShare,
  Space_DB_Mapping: run.spaceDbMapping,
  Customer_PG_Version: run.customerPgVersion,
  SSRF_Disabled:
    run.ssrfDisabled === undefined ? undefined : Boolean(run.ssrfDisabled),
  V2_Ratio_Per_Endpoint: run.v2RatioPerEndpoint,
  Budget_Level: run.budgetLevel,
  Est_Run_Cost: run.estimatedRunCost,
  Actual_Run_Cost: effectiveActualRunCost,
  Actual_DB_Hours: run.actualDbHours,
  Actual_AppNode_Hours: run.actualAppNodeHours,
  Actual_LoadGen_Hours: run.actualLoadGenHours,
  Actual_SigNoz_Ingest_GB: run.actualSignozIngestGb,
  Cost_Anomaly: effectiveCostAnomaly,
  Resource_Json: run.resourceJson,
  Cleanup_Status: run.cleanupStatus,
  PerfLab_Run_ID: run.perfLabRunId,
  SigNoz_Dashboard_URI: run.signozDashboardUri,
  SigNoz_Annotation_ID: run.signozAnnotationId,
  Baseline_Run_ID: run.baselineRunId,
  ...(writeGateFields
    ? {
        Parent_Run_ID: link(parentRunRecordId),
        Step_Target_RPS: run.stepTargetRps,
        Row_Kind: run.rowKind || "summary",
        Scenario_Label: run.scenarioLabel || run.scenarioSet,
        Capacity_Bound: gatePlan?.capacity?.capacityBound,
        Cost_Coverage: gatePlan?.cost?.coverage,
        Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted",
      }
    : {}),
});

if (!run.startTime || !run.endTime) {
  summary.warnings.push(
    "run.startTime/endTime missing; 开始时间/结束时间 use recorder time (legacy fallback)",
  );
}
if (!run.windowStart || !run.windowEnd) {
  summary.warnings.push(
    "run.windowStart/windowEnd missing; 窗口 uses run start/end (legacy fallback)",
  );
}
let datasetRecordId = run.datasetRecordId || null;
if (!dryRun && !datasetRecordId && run.datasetKey) {
  datasetRecordId = await findRecord(
    TABLES.dataset,
    "数据集ID",
    run.datasetKey,
  );
}
if (datasetRecordId) runFields.数据集 = link(datasetRecordId);

const runRecordId = await upsert(TABLES.run, "证据键", runKey, runFields);
summary.runRecordId = runRecordId;

const scenarioIds = [];
for (const [scenarioIndex, scenario] of (bundle.scenarios || []).entries()) {
  const explicitScenarioId = supplied(scenario.scenarioId);
  const explicitCatalogId = supplied(scenario.catalogId);
  if (
    explicitScenarioId &&
    explicitCatalogId &&
    explicitScenarioId !== explicitCatalogId
  ) {
    throw new Error(
      `scenarios[] has conflicting scenarioId=${explicitScenarioId} and catalogId=${explicitCatalogId}`,
    );
  }
  const inheritedScenarioId = supplied(run.scenarioId);
  const scenarioRef =
    explicitScenarioId || explicitCatalogId || supplied(scenario.scenario);
  if (!scenarioRef) {
    throw new Error(
      "scenarios[] entries require scenarioId, catalogId, or scenario",
    );
  }
  const mode = supplied(scenario.mode) ?? supplied(run.mode);
  const repeat = supplied(scenario.repeat) ?? supplied(run.repeat);
  const operationKey =
    supplied(scenario.operationKey) ?? supplied(scenario.operation);
  const operationDimension =
    operationKey ??
    (explicitScenarioId ? supplied(scenario.scenario) : undefined);
  if (keyFormat === "v2" && !explicitScenarioId && !explicitCatalogId) {
    throw new Error(
      "stress-evidence-v2 requires scenarios[].scenarioId/catalogId: one canonical Scenario_ID, no per-run labels",
    );
  }
  const scenarioKey =
    scenario.evidenceKey ||
    buildEvidenceKey(
      "result",
      {
        runId: run.runId,
        scenarioId: scenarioRef,
        mode,
        repeat,
        operationKey: operationDimension,
      },
      { format: keyFormat },
    );
  const catalogLookupId =
    explicitScenarioId ||
    explicitCatalogId ||
    inheritedScenarioId ||
    scenarioRef;
  let catalogRecordId = scenario.catalogRecordId || null;
  let catalogRecord = null;
  if (!dryRun && !catalogRecordId) {
    catalogRecord = await findRecordEntry(
      TABLES.catalog,
      "场景ID",
      catalogLookupId,
    );
    catalogRecordId = catalogRecord?.id || null;
    if (
      !catalogRecordId &&
      (explicitScenarioId || explicitCatalogId || inheritedScenarioId)
    ) {
      throw new Error(
        `scenarios[] ${catalogLookupId}: no row in ${TABLES.catalog} with 场景ID=${catalogLookupId}`,
      );
    }
  }
  if (keyFormat === "v2" && catalogRecord) {
    const catalogSpec = supplied(
      catalogRecord.fields?.Spec_Version ?? catalogRecord.fields?.specVersion,
    );
    const effectiveSpec =
      supplied(scenario.specVersion) ?? supplied(run.specVersion);
    if (catalogSpec !== undefined && !effectiveSpec) {
      throw new Error(
        `scenarios[] ${catalogLookupId}: catalog Spec_Version=${catalogSpec} but the bundle has no Spec_Version`,
      );
    }
    if (
      catalogSpec !== undefined &&
      String(catalogSpec) !== String(effectiveSpec)
    ) {
      throw new Error(
        `scenarios[] ${catalogLookupId}: catalog Spec_Version=${catalogSpec} != effective Spec_Version=${effectiveSpec}`,
      );
    }
  }
  const scenarioVerdict =
    gateMode === "report"
      ? scenario.verdict || "inconclusive"
      : gatePlan
        ? decideVerdict(
            gatePlan.scenarios[scenarioIndex]?.verdict,
            scenario.verdict,
            `scenario[${scenarioIndex}] ${scenarioRef}`,
          )
        : scenario.verdict || "inconclusive";
  const fields = compact({
    结果ID: scenarioKey,
    运行: link(runRecordId),
    场景: scenario.scenario,
    负载模型: scenario.loadModel || run.loadModel || "open_arrival",
    目标RPS: scenario.targetRps,
    并发VU: scenario.vus,
    持续秒: scenario.durationSec,
    请求数: scenario.requests,
    成功数: scenario.success,
    失败数: scenario.failed,
    成功率百分比: scenario.successRate,
    P50毫秒: scenario.p50,
    P95毫秒: scenario.p95,
    P99毫秒: scenario.p99,
    P999毫秒: scenario.p999,
    服务端P95毫秒: scenario.serverP95,
    服务端P99毫秒: scenario.serverP99,
    错误率百分比: scenario.errorRate,
    错误类型分布: scenario.errorDistribution || "",
    饱和资源: scenario.saturatedResource || "unknown",
    拐点RPS: scenario.kneeRps,
    判定: scenarioVerdict,
    证据链接: scenario.evidenceUrl || "",
    说明: scenario.notes || "",
    证据键: scenarioKey,
    分类: scenario.category || run.category || "core",
    Token数: scenario.tokens,
    估算成本USD: scenario.estimatedCostUsd,
    每次成功操作成本USD: scenario.costPerSuccessUsd,
    缓存命中率百分比: scenario.cacheHitRate,
    Scenario_ID: explicitScenarioId || explicitCatalogId || inheritedScenarioId,
    Spec_Version: supplied(scenario.specVersion) ?? supplied(run.specVersion),
    Mode: mode,
    Repeat: repeat,
    Operation_Key: operationDimension,
    Instance_ID: supplied(scenario.instanceId),
    P95_Meta_ms: scenario.p95Meta,
    P95_Tenant_ms: scenario.p95Tenant,
    Pool_Waiting_Max: scenario.poolWaitingMax,
    Pool_Limit: scenario.poolLimit,
    Pool_References: scenario.poolReferences,
    Correctness: scenario.correctness,
    Max_Sustainable_RPS: writeGateFields
      ? undefined
      : scenario.maxSustainableRps,
    Baseline_Run_ID: supplied(scenario.baselineRunId),
    Effect_Abs: scenario.effectAbs,
    Effect_Relative: scenario.effectRelative,
    CI_Low: scenario.ciLow,
    CI_High: scenario.ciHigh,
    Sample_Count: scenario.sampleCount,
    ...(writeGateFields
      ? {
          Max_Passing_RPS: gatePlan?.capacity?.maxPassingRps,
          Max_Sustainable_RPS: gatePlan
            ? gatePlan.capacity?.maxSustainableRps
            : scenario.maxSustainableRps,
          Capacity_Bound: gatePlan?.capacity?.capacityBound,
          Step_Target_RPS:
            scenario.stepTargetRps ??
            (run.rowKind === "step" ? scenario.targetRps : undefined),
          Scenario_Label: supplied(scenario.scenarioLabel),
          SLO_P95_MS: supplied(scenario.sloP95Ms),
          Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted",
        }
      : {}),
  });
  if (catalogRecordId) fields.场景目录 = link(catalogRecordId);
  const id = await upsert(TABLES.scenario, "结果ID", scenarioKey, fields);
  scenarioIds.push(id);
}
summary.scenarioRecordIds = scenarioIds;

const metricIds = [];
for (const metric of bundle.metrics || []) {
  if (!supplied(metric.metric))
    throw new Error("metrics[] entries require metric");
  if (keyFormat === "v2") {
    const error = invalidWindow(
      `metrics[] ${metric.metric}`,
      metric.windowStart,
      metric.windowEnd,
      run.windowStart,
      run.windowEnd,
    );
    if (error) {
      console.error(error);
      process.exit(2);
    }
  }
  const runWindowStart = iso(run.windowStart, iso(run.startTime, null));
  const runWindowEnd = iso(run.windowEnd, iso(run.endTime, null));
  const windowStart = iso(metric.windowStart, runWindowStart);
  const windowEnd = iso(metric.windowEnd, runWindowEnd);
  if (!windowStart) {
    throw new Error(
      `metrics[] ${metric.metric}: windowStart is required (metric or run window)`,
    );
  }
  const mode = supplied(metric.mode) ?? supplied(run.mode);
  const repeat = supplied(metric.repeat) ?? supplied(run.repeat);
  const operationKey =
    supplied(metric.operationKey) ?? supplied(metric.operation);
  const metricScenarioId =
    supplied(metric.scenarioId) ??
    supplied(metric.catalogId) ??
    supplied(run.scenarioId);
  const metricScenario = supplied(metric.scenario) || "all";
  const metricInstance =
    supplied(metric.instanceKey) ?? supplied(metric.serviceInstance);
  const metricDbRole = supplied(metric.dbRole);
  const metricKey =
    metric.evidenceKey ||
    buildEvidenceKey(
      "metric",
      {
        runId: run.runId,
        metricKey: metric.metric,
        scenario: metricScenario,
        scenarioId: metricScenarioId,
        mode,
        repeat,
        operationKey,
        dbRole: metricDbRole,
        instanceKey: metricInstance,
        windowStart,
      },
      { format: keyFormat },
    );
  const value = numericOrNull(metric.value);
  const hasValue = value !== null;
  const requestedCollection = supplied(metric.collectionStatus);
  let collectionStatus =
    requestedCollection || (hasValue ? "observed" : "no_data");
  if (!hasValue && collectionStatus === "observed") {
    collectionStatus = "no_data";
    summary.warnings.push(
      `${metricKey}: 数值 missing; 采集状态 observed -> no_data`,
    );
  }
  const requestedStatus = supplied(metric.status);
  if (!hasValue && requestedStatus && requestedStatus !== "no_data") {
    summary.warnings.push(
      `${metricKey}: 数值 missing; 状态 ${requestedStatus} -> no_data`,
    );
  }
  const status = hasValue ? requestedStatus || "unknown" : "no_data";
  const fields = compact({
    证据键: metricKey,
    运行: link(runRecordId),
    场景: metric.scenario || "all",
    指标: metric.metric,
    指标类型: metric.metricType || "saturation",
    环境: metric.environment || run.environment || "staging",
    服务实例: metricInstance || "",
    窗口开始: windowStart,
    窗口结束: windowEnd,
    数值: value,
    阈值: metric.threshold,
    超阈值:
      metric.overThreshold === undefined || metric.overThreshold === null
        ? undefined
        : Boolean(metric.overThreshold),
    单位: metric.unit || "unknown",
    样本数: metric.samples,
    状态: status,
    采集状态: collectionStatus,
    来源: metric.source || "signoz",
    查询收据: metric.queryReceipt || "",
    源头链接: metric.sourceUrl || "",
    口径版本: metric.schemaVersion || bundleSchema,
    备注: metric.notes || "",
    分类: metric.category || run.category || "core",
    Token数: metric.tokens,
    成本USD: metric.costUsd,
    Scenario_ID: metricScenarioId,
    Spec_Version: supplied(metric.specVersion) ?? supplied(run.specVersion),
    Mode: mode,
    Repeat: repeat,
    Db_Role: metricDbRole,
    ...(writeGateFields
      ? { Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted" }
      : {}),
  });
  metricIds.push(await upsert(TABLES.metric, "证据键", metricKey, fields));
}
summary.metricRecordIds = metricIds;

const bottleneckIds = [];
for (const [index, item] of (bundle.bottlenecks || []).entries()) {
  const bottleneckKey =
    item.evidenceKey ||
    buildEvidenceKey(
      "bottleneck",
      { runId: run.runId, seq: item.id || String(index + 1).padStart(3, "0") },
      { format: keyFormat },
    );
  const fields = compact({
    编号: item.id || bottleneckKey,
    运行: link(runRecordId),
    Scenario_ID:
      supplied(item.scenarioId) ??
      supplied(item.catalogId) ??
      supplied(run.scenarioId),
    场景: item.scenario || "all",
    现象: item.symptom || "",
    证据链接: item.evidenceUrl || "",
    根因假设: item.rootCauseHypothesis || "",
    验证方法: item.verificationMethod || "",
    优化动作: item.action || "",
    代码变更: item.codeChange || "",
    优化前P95毫秒: item.beforeP95,
    优化后P95毫秒: item.afterP95,
    优化前P99毫秒: item.beforeP99,
    优化后P99毫秒: item.afterP99,
    变化百分比: item.changePct,
    验证运行ID: item.verificationRunId || "",
    状态: item.status || "open",
    优先级: item.priority || "P2",
    负责人: item.owner || "",
    截止日期: item.dueDate ? iso(item.dueDate, null) : undefined,
    结论: item.conclusion || "",
    证据键: bottleneckKey,
    分类: item.category || run.category || "core",
    ...(writeGateFields
      ? { Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted" }
      : {}),
  });
  bottleneckIds.push(
    await upsert(TABLES.bottleneck, "证据键", bottleneckKey, fields),
  );
}
summary.bottleneckRecordIds = bottleneckIds;

const correctnessIds = [];
for (const check of bundle.correctness || []) {
  if (!supplied(check.checkKey))
    throw new Error("correctness[] entries require checkKey");
  const scenarioId =
    supplied(check.scenarioId) ??
    supplied(check.catalogId) ??
    supplied(run.scenarioId);
  const mode = supplied(check.mode) ?? supplied(run.mode);
  const repeat = supplied(check.repeat) ?? supplied(run.repeat);
  const operationKey =
    supplied(check.operationKey) ?? supplied(check.operation);
  const checkKey =
    check.evidenceKey ||
    buildEvidenceKey(
      "check",
      {
        runId: run.runId,
        checkKey: check.checkKey,
        scenarioId,
        mode,
        repeat,
        operationKey,
      },
      { format: keyFormat },
    );
  const fields = compact({
    证据键: checkKey,
    运行: link(runRecordId),
    Scenario_ID: scenarioId,
    Spec_Version: supplied(check.specVersion) ?? supplied(run.specVersion),
    Repeat: repeat,
    Mode: mode,
    Check_Key: check.checkKey,
    Expected: check.expected || "",
    Observed: check.observed || "",
    Delta: check.delta,
    Tolerance: check.tolerance,
    Status: supplied(check.status),
    Evidence_URI: check.evidenceUri || "",
    ...(writeGateFields
      ? {
          Verifier: supplied(check.verifier),
          Sample_Ref: supplied(check.sampleRef),
          Permission_Check:
            check.permissionCheck === undefined
              ? undefined
              : Boolean(check.permissionCheck),
          Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted",
        }
      : {}),
  });
  correctnessIds.push(
    await upsert(TABLES.correctness, "证据键", checkKey, fields),
  );
}
summary.correctnessRecordIds = correctnessIds;

const resourceIds = [];
for (const resource of bundle.resources || []) {
  if (!supplied(resource.resourceId))
    throw new Error("resources[] entries require resourceId");
  const resourceKey =
    resource.evidenceKey ||
    buildEvidenceKey(
      "resource",
      { runId: run.runId, resourceKey: resource.resourceId },
      { format: keyFormat },
    );
  const fields = compact({
    证据键: resourceKey,
    运行: link(runRecordId),
    Resource_ID: resource.resourceId,
    Resource_Type: supplied(resource.resourceType),
    Instance_Key: supplied(resource.instanceKey),
    Created_At: supplied(resource.createdAt)
      ? iso(resource.createdAt, null)
      : undefined,
    Deleted_At: supplied(resource.deletedAt)
      ? iso(resource.deletedAt, null)
      : undefined,
    Actual_Hours: resource.actualHours,
    Actual_Cost: resource.actualCost,
    Cleanup_Attempts: resource.cleanupAttempts,
    Deletion_Verified:
      resource.deletionVerified === undefined
        ? undefined
        : Boolean(resource.deletionVerified),
    Cleanup_Status: supplied(resource.cleanupStatus),
    Receipt_JSON: supplied(resource.receiptJson),
    ...(writeGateFields
      ? {
          Deletion_Evidence_Code: supplied(resource.deletionEvidenceCode),
          Deleted_At_Source: supplied(resource.deletedAtSource),
          Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted",
        }
      : {}),
  });
  resourceIds.push(
    await upsert(TABLES.resource, "证据键", resourceKey, fields),
  );
}
summary.resourceRecordIds = resourceIds;

const costIds = [];
for (const cost of bundle.costs || []) {
  const requestedComponent = supplied(cost.costComponent) || "other";
  const component =
    keyFormat === "v2"
      ? normalizeCostComponent(requestedComponent)
      : requestedComponent;
  const scenarioId =
    supplied(cost.scenarioId) ??
    supplied(cost.catalogId) ??
    supplied(cost.scenario) ??
    supplied(run.scenarioId);
  const mode = supplied(cost.mode) ?? supplied(run.mode);
  const repeat = supplied(cost.repeat) ?? supplied(run.repeat);
  const costKey =
    cost.evidenceKey ||
    buildEvidenceKey(
      "cost",
      {
        runId: run.runId,
        scenarioId: scenarioId || "all",
        component,
        mode,
        repeat,
      },
      { format: keyFormat },
    );
  const fields = compact({
    证据键: costKey,
    运行: link(runRecordId),
    场景: scenarioId || "all",
    Spec_Version: supplied(cost.specVersion) ?? supplied(run.specVersion),
    Repeat: repeat,
    Mode: mode,
    Model_Version: supplied(cost.modelVersion),
    Currency: supplied(cost.currency),
    Cost_Component: component,
    Quantity: cost.quantity,
    Hours: cost.hours,
    Unit_Price: cost.unitPrice,
    Est_Amount: cost.estAmount,
    Actual_Amount: cost.actualAmount,
    CI_JSON: cost.ciJson,
    Cost_Per_10k_Ops: cost.costPer10kOps,
    Net_Margin: cost.netMargin,
    BreakEven_Ratio: cost.breakEvenRatio,
    Capacity_Shared_RPS: cost.capacitySharedRps,
    Capacity_BYODB_RPS: cost.capacityByodbRps,
    Delta_Capacity: cost.deltaCapacity,
    Performance_Per_Yuan: cost.performancePerYuan,
    结论: cost.conclusion || "",
    备注: cost.notes || "",
    ...(writeGateFields
      ? {
          Estimated_At: supplied(cost.estimatedAt)
            ? iso(cost.estimatedAt, null)
            : undefined,
          Base_Currency: supplied(cost.baseCurrency),
          FX_Rate: cost.fxRate,
          FX_AsOf: supplied(cost.fxAsOf) ? iso(cost.fxAsOf, null) : undefined,
          Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted",
        }
      : {}),
  });
  costIds.push(await upsert(TABLES.cost, "证据键", costKey, fields));
}
summary.costRecordIds = costIds;

const reportIds = [];
for (const report of bundle.reports || []) {
  const reportKey =
    supplied(report.reportKey) || supplied(report.chartKey) || run.runId;
  const reportVersion = supplied(report.reportVersion) || "v1";
  if (keyFormat === "v2") {
    const error = invalidWindow(
      `reports[] ${reportKey}`,
      report.windowStart,
      report.windowEnd,
      run.windowStart,
      run.windowEnd,
    );
    if (error) {
      console.error(error);
      process.exit(2);
    }
  }
  const evidenceKey =
    report.evidenceKey ||
    buildEvidenceKey(
      "report",
      { reportKey, reportVersion },
      { format: keyFormat },
    );
  const fields = compact({
    证据键: evidenceKey,
    运行: link(runRecordId),
    Report_Key: reportKey,
    Report_Version: reportVersion,
    Report_Type: supplied(report.reportType),
    Chart_Key: supplied(report.chartKey),
    Source_Tables: supplied(report.sourceTables),
    Query_Receipt: supplied(report.queryReceipt),
    Window_Start: supplied(report.windowStart)
      ? iso(report.windowStart, null)
      : undefined,
    Window_End: supplied(report.windowEnd)
      ? iso(report.windowEnd, null)
      : undefined,
    URI: supplied(report.uri),
    Data_Hash: supplied(report.dataHash),
    Generated_At: supplied(report.generatedAt)
      ? iso(report.generatedAt, null)
      : undefined,
    Status: supplied(report.status),
    ...(writeGateFields
      ? { Key_Version: keyFormat === "v2" ? "v2" : "v1-drifted" }
      : {}),
  });
  reportIds.push(await upsert(TABLES.report, "证据键", evidenceKey, fields));
}
summary.reportRecordIds = reportIds;

if (outPath) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(summary, null, 2));
}
console.log(JSON.stringify(summary, null, 2));
