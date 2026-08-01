#!/usr/bin/env node

// Publish the trace viewer site.
//
// A perf run already produces everything a trace viewer needs: the report job
// replays selected traces into its own Jaeger and writes the Jaeger-format
// snapshot next to each manifest. What it could not produce was a link anyone
// could click, because the only long-lived viewer was a VM that is gone.
//
// This turns the run's own snapshots into a static site: one slimmed JSON per
// linked trace under `r/<runId>/`, plus the viewer HTML.
//
// Retention is a byte budget rather than an age. A published full run measures
// ~124 MB (533 result rows averaging 232 KB, measured on run 30708195561), and
// GitHub Pages serves up to 1 GB, so the site keeps the newest runs that fit
// under 800 MB — roughly six full runs — and evicts oldest-first only when it
// has to. An age limit would throw away traces while most of the capacity sat
// unused. `pinned/` is never evicted: that is the escape hatch for a trace
// worth keeping as evidence.

import {
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileAtomically } from "../framework/atomic-file.js";
import {
  primaryMetricValue,
  readArtifactPayloads,
  resolvePrimaryTraceRef,
} from "./perf-artifact-read-model.mjs";

export const DEFAULT_MAX_TAG_BYTES = 2_048;
export const DEFAULT_MAX_SPANS = 3_000;
// 800 MB against the 1 GB Pages ceiling. The headroom is deliberate: the run
// being published is never evicted, so the site can exceed the budget when
// pinned traces plus one run already fill it, and that has to stay short of the
// hard limit for the warning to be actionable.
export const DEFAULT_SITE_BUDGET_BYTES = 800_000_000;

const RUN_DIR = "r";
const PINNED_DIR = "pinned";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const writeJson = (path, value) =>
  writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);

const readJsonIfPossible = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
};

// Jaeger tag values carry the whole SQL statement — up to the 256 KB the spool
// sanitizer allows. That is worth keeping in the artifact and not worth pushing
// to a static site once per run, so the site copy keeps the head of the value
// and says how much it dropped.
const boundTagValue = (value, maxTagBytes) => {
  const text =
    typeof value === "string"
      ? value
      : value == null
        ? ""
        : JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes <= maxTagBytes) {
    return { text, droppedBytes: 0 };
  }
  const kept = Buffer.from(text)
    .subarray(0, maxTagBytes)
    .toString("utf8")
    .replace(/�$/, "");
  return {
    text: `${kept}…[+${bytes - Buffer.byteLength(kept)} bytes]`,
    droppedBytes: bytes - Buffer.byteLength(kept),
  };
};

const parentSpanId = (span, traceId) => {
  for (const reference of span?.references ?? []) {
    if (
      reference?.refType === "CHILD_OF" &&
      (!reference.traceID || reference.traceID === traceId) &&
      reference.spanID
    ) {
      return reference.spanID;
    }
  }
  return undefined;
};

export const slimJaegerTrace = ({
  snapshot,
  traceId,
  maxTagBytes = DEFAULT_MAX_TAG_BYTES,
  maxSpans = DEFAULT_MAX_SPANS,
}) => {
  const traces = Array.isArray(snapshot?.data) ? snapshot.data : [];
  const trace =
    traces.find((candidate) => candidate?.traceID === traceId) ?? traces[0];
  if (!isRecord(trace) || !Array.isArray(trace.spans)) {
    throw new Error(`Jaeger snapshot for ${traceId} contains no spans.`);
  }

  const processes = isRecord(trace.processes) ? trace.processes : {};
  const ordered = [...trace.spans].sort(
    (left, right) =>
      Number(left?.startTime ?? 0) - Number(right?.startTime ?? 0),
  );
  const kept = ordered.slice(0, maxSpans);

  let droppedTagBytes = 0;
  const spans = kept.map((span) => {
    const tags = {};
    for (const tag of span?.tags ?? []) {
      if (!tag?.key) {
        continue;
      }
      const bounded = boundTagValue(tag.value, maxTagBytes);
      droppedTagBytes += bounded.droppedBytes;
      tags[tag.key] = bounded.text;
    }
    return {
      id: span?.spanID,
      parentId: parentSpanId(span, trace.traceID),
      name: span?.operationName ?? "",
      service: processes[span?.processID]?.serviceName,
      startUs: Number(span?.startTime ?? 0),
      durationUs: Number(span?.duration ?? 0),
      tags,
    };
  });

  return {
    traceId: trace.traceID ?? traceId,
    spans,
    spanCount: ordered.length,
    droppedSpanCount: ordered.length - kept.length,
    droppedTagBytes,
  };
};

export const buildTraceDocument = ({
  payload,
  ref,
  snapshot,
  runId,
  runUrl,
  maxTagBytes,
  maxSpans,
}) => ({
  ...slimJaegerTrace({
    snapshot,
    traceId: ref.traceId,
    maxTagBytes,
    maxSpans,
  }),
  runId,
  case: {
    caseId: payload.caseId,
    title: payload.title,
    engine: payload.engine,
    result: payload.result,
    durationMs: primaryMetricValue(payload),
    stepId: ref.stepId,
    url: ref.url,
    runUrl,
  },
});

// One trace per result row: the same ref the Teable row links to. Publishing
// every selected trace would be ~1000 files and hundreds of megabytes a day for
// links nothing points at.
export const collectPublishableTraces = async ({ artifactDir }) => {
  // A run whose execute jobs all failed downloads no artifacts at all. Publish
  // an empty run rather than failing the step: the viewer is not the place to
  // report that the run collapsed, and the acceptance gate already does.
  if (!(await stat(artifactDir).catch(() => undefined))) {
    return { publishable: [], skipped: [] };
  }

  const payloadEntries = await readArtifactPayloads({
    artifactDir,
    includeSeed: false,
    allowEmpty: true,
  });

  const publishable = [];
  const skipped = [];
  for (const { payload, payloadPath } of payloadEntries) {
    const traceManifest = payload?.details?.observability?.traces;
    const ref = resolvePrimaryTraceRef({ payload, traceManifest });
    if (!ref?.traceId) {
      skipped.push({
        caseId: payload.caseId,
        engine: payload.engine,
        reason: "no captured trace refs",
      });
      continue;
    }
    const saved = (traceManifest?.savedTraces ?? []).find(
      (trace) =>
        trace?.traceId === ref.traceId && trace?.status === "saved" && trace.path,
    );
    if (!saved) {
      skipped.push({
        caseId: payload.caseId,
        engine: payload.engine,
        traceId: ref.traceId,
        reason: "primary trace has no stored Jaeger snapshot",
      });
      continue;
    }
    publishable.push({
      payload,
      ref,
      snapshotPath: resolve(dirname(payloadPath), saved.path),
    });
  }

  publishable.sort(
    (left, right) =>
      String(left.payload.caseId).localeCompare(String(right.payload.caseId)) ||
      String(left.payload.engine).localeCompare(String(right.payload.engine)),
  );
  return { publishable, skipped };
};

const directoryBytes = async (directory) => {
  let total = 0;
  const walk = async (current) => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile()) {
        total += (await stat(path)).size;
      }
    }
  };
  await walk(directory).catch(() => {});
  return total;
};

// Everything the budget has to pay for before a single run fits: the viewer, and
// the pinned traces, which are never evicted. Counting them keeps the budget
// honest — a site that ignored pinned bytes would drift past the Pages ceiling
// exactly as more traces got pinned.
const reservedSiteBytes = async (siteDir) => {
  let total = 0;
  for (const entry of await readdir(siteDir, { withFileTypes: true }).catch(
    () => [],
  )) {
    if (entry.name === RUN_DIR) {
      continue;
    }
    const path = join(siteDir, entry.name);
    total += entry.isDirectory()
      ? await directoryBytes(path)
      : ((await stat(path).catch(() => undefined))?.size ?? 0);
  }
  return total;
};

export const enforceSiteBudget = async ({
  siteDir,
  budgetBytes,
  keepRunId,
}) => {
  const runsRoot = join(siteDir, RUN_DIR);
  const entries = await readdir(runsRoot, { withFileTypes: true }).catch(
    () => [],
  );

  const evicted = [];
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const runDir = join(runsRoot, entry.name);
    const index = await readJsonIfPossible(join(runDir, "index.json"));
    if (!index?.publishedAt && entry.name !== keepRunId) {
      // No index means nothing links here and nothing can date it. Drop it
      // rather than let it hold budget forever.
      const bytes = await directoryBytes(runDir);
      await rm(runDir, { recursive: true, force: true });
      evicted.push({ runId: entry.name, bytes, reason: "no run index" });
      continue;
    }
    candidates.push({
      runId: index?.runId ?? entry.name,
      dirName: entry.name,
      publishedAt: index?.publishedAt,
      traceCount: index?.traces?.length ?? 0,
      runUrl: index?.runUrl,
      teableEeRef: index?.teableEeRef,
      bytes: await directoryBytes(runDir),
    });
  }

  // Newest first, with the run being published pinned to the front: its links
  // are the ones this workflow is about to hand out, so it is never the thing
  // that gets dropped to make room.
  candidates.sort((left, right) => {
    if (left.dirName === keepRunId) return -1;
    if (right.dirName === keepRunId) return 1;
    return String(right.publishedAt ?? "").localeCompare(
      String(left.publishedAt ?? ""),
    );
  });

  const reservedBytes = await reservedSiteBytes(siteDir);
  const kept = [];
  let usedBytes = reservedBytes;
  for (const candidate of candidates) {
    const fits = usedBytes + candidate.bytes <= budgetBytes;
    if (fits || candidate.dirName === keepRunId) {
      usedBytes += candidate.bytes;
      kept.push(candidate);
      continue;
    }
    await rm(join(runsRoot, candidate.dirName), {
      recursive: true,
      force: true,
    });
    evicted.push({
      runId: candidate.runId,
      publishedAt: candidate.publishedAt,
      traceCount: candidate.traceCount,
      bytes: candidate.bytes,
      reason: "site byte budget",
    });
  }

  return {
    evicted,
    kept: kept.map(({ dirName: _dirName, ...run }) => run),
    reservedBytes,
    usedBytes,
    budgetBytes,
    overBudgetBytes: Math.max(0, usedBytes - budgetBytes),
  };
};

export const publishTraceSite = async ({
  artifactDir,
  siteDir,
  viewerDir,
  runId,
  runUrl,
  teableEeRef,
  publishedAt,
  budgetBytes = DEFAULT_SITE_BUDGET_BYTES,
  maxTagBytes = DEFAULT_MAX_TAG_BYTES,
  maxSpans = DEFAULT_MAX_SPANS,
}) => {
  if (!runId) {
    throw new Error("A run id is required to publish the trace site.");
  }

  const { publishable, skipped } = await collectPublishableTraces({
    artifactDir,
  });

  const runDir = join(siteDir, RUN_DIR, runId);
  await rm(runDir, { recursive: true, force: true });
  await mkdir(runDir, { recursive: true });

  const traces = [];
  let droppedTagBytes = 0;
  let droppedSpanCount = 0;
  for (const { payload, ref, snapshotPath } of publishable) {
    const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
    const document = buildTraceDocument({
      payload,
      ref,
      snapshot,
      runId,
      runUrl,
      maxTagBytes,
      maxSpans,
    });
    // Name the file after the ref, not after whatever the snapshot says. The
    // result row's link is built from the ref, so anything else is a 404 that
    // only shows up when someone clicks it.
    await writeJson(join(runDir, `${ref.traceId}.json`), document);
    droppedTagBytes += document.droppedTagBytes;
    droppedSpanCount += document.droppedSpanCount;
    traces.push({
      traceId: ref.traceId,
      caseId: payload.caseId,
      engine: payload.engine,
      result: payload.result,
      durationMs: document.case.durationMs,
      stepId: ref.stepId,
      spanCount: document.spanCount,
    });
  }

  await writeJson(join(runDir, "index.json"), {
    runId,
    runUrl,
    teableEeRef,
    publishedAt,
    traces,
  });

  await mkdir(join(siteDir, PINNED_DIR), { recursive: true });
  if (!(await readJsonIfPossible(join(siteDir, PINNED_DIR, "index.json")))) {
    await writeJson(join(siteDir, PINNED_DIR, "index.json"), { traces: [] });
  }

  for (const fileName of ["index.html", "trace.html"]) {
    await cp(join(viewerDir, fileName), join(siteDir, fileName));
  }
  // Pages runs Jekyll by default, which drops files it considers special and
  // adds a build step this site does not need.
  await writeFileAtomically(join(siteDir, ".nojekyll"), "");
  await writeFileAtomically(
    join(siteDir, "robots.txt"),
    "User-agent: *\nDisallow: /\n",
  );

  // Everything the budget pays for has to exist before it is measured, so this
  // runs after the viewer and the pinned index are on disk.
  const budget = await enforceSiteBudget({
    siteDir,
    budgetBytes,
    keepRunId: runId,
  });

  await writeJson(join(siteDir, "runs.json"), {
    budgetBytes: budget.budgetBytes,
    usedBytes: budget.usedBytes,
    reservedBytes: budget.reservedBytes,
    runs: budget.kept,
  });

  return {
    runId,
    publishedAt,
    publishedTraceCount: traces.length,
    skipped,
    droppedTagBytes,
    droppedSpanCount,
    evictedRuns: budget.evicted,
    retainedRuns: budget.kept.map(({ runId: id }) => id),
    budgetBytes: budget.budgetBytes,
    reservedBytes: budget.reservedBytes,
    overBudgetBytes: budget.overBudgetBytes,
    siteBytes: await directoryBytes(siteDir),
  };
};

const optionalArgument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const requiredArgument = (name) => {
  const value = optionalArgument(name);
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return value;
};

const main = async () => {
  const viewerDir = optionalArgument("--viewer")
    ? resolve(optionalArgument("--viewer"))
    : resolve(dirname(fileURLToPath(import.meta.url)), "../viewer");
  const summary = await publishTraceSite({
    artifactDir: resolve(requiredArgument("--artifact-dir")),
    siteDir: resolve(requiredArgument("--site")),
    viewerDir,
    runId: requiredArgument("--run-id"),
    runUrl: optionalArgument("--run-url"),
    teableEeRef: optionalArgument("--teable-ee-ref"),
    publishedAt: optionalArgument("--now") ?? new Date().toISOString(),
    budgetBytes: Number(
      optionalArgument("--budget-bytes") ?? DEFAULT_SITE_BUDGET_BYTES,
    ),
  });

  const summaryPath = optionalArgument("--summary-path");
  if (summaryPath) {
    await writeJson(resolve(summaryPath), summary);
  }

  const mb = (bytes) => `${(bytes / 1_000_000).toFixed(1)} MB`;
  console.log(
    `Published ${summary.publishedTraceCount} traces for run ${summary.runId}; ` +
      `retained ${summary.retainedRuns.length} runs, evicted ${summary.evictedRuns.length}, ` +
      `site is ${mb(summary.siteBytes)} of a ${mb(summary.budgetBytes)} budget.`,
  );
  // The published run is never evicted, so the only way past the budget is
  // pinned traces plus one run. Say it where someone will see it, while there is
  // still headroom below the 1 GB Pages ceiling to act on.
  if (summary.overBudgetBytes > 0) {
    console.warn(
      `::warning::Trace site is ${mb(summary.overBudgetBytes)} over its ${mb(summary.budgetBytes)} budget ` +
        `with ${mb(summary.reservedBytes)} held by pinned traces and the viewer. Unpin traces to make room.`,
    );
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Trace viewer publication",
        "",
        `- published traces: ${summary.publishedTraceCount}`,
        `- results without a stored trace: ${summary.skipped.length}`,
        `- site: ${mb(summary.siteBytes)} of ${mb(summary.budgetBytes)} (${mb(summary.reservedBytes)} pinned + viewer)`,
        `- retained runs: ${summary.retainedRuns.length}`,
        `- evicted for budget: ${summary.evictedRuns.map(({ runId }) => runId).join(", ") || "none"}`,
        ...(summary.overBudgetBytes > 0
          ? [`- ⚠️ over budget by ${mb(summary.overBudgetBytes)}`]
          : []),
        "",
      ].join("\n"),
      { flag: "a" },
    );
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}

export { RUN_DIR, PINNED_DIR };
