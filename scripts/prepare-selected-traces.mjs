#!/usr/bin/env node

import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const isRecord = (value) =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const REDACTED_SPAN_ATTRIBUTE_KEYS = new Set(["db.postgresql.values"]);
const BOUNDED_SQL_ATTRIBUTE_KEYS = new Set(["db.query.text", "db.statement"]);
const MAX_SQL_ATTRIBUTE_BYTES = 256_000;
const TRUNCATED_ATTRIBUTE_MARKER_KEY = "perf_lab.truncated_trace_attributes";

const truncateUtf8 = (value, maxBytes) => {
  if (Buffer.byteLength(value) <= maxBytes) {
    return value;
  }
  return Buffer.from(value)
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
};

export const sanitizeSelectedTraceAttributes = (payload) => {
  let redactedAttributeCount = 0;
  let redactedAttributeBytes = 0;
  let truncatedAttributeCount = 0;
  let truncatedAttributeBytes = 0;

  for (const resourceSpans of payload?.resourceSpans ?? []) {
    for (const scopeSpans of resourceSpans?.scopeSpans ?? []) {
      for (const span of scopeSpans?.spans ?? []) {
        if (!Array.isArray(span?.attributes)) {
          continue;
        }
        const retainedAttributes = [];
        let spanRedactedAttributeCount = 0;
        const truncatedAttributes = [];
        for (const attribute of span.attributes) {
          if (
            isRecord(attribute) &&
            REDACTED_SPAN_ATTRIBUTE_KEYS.has(attribute.key)
          ) {
            redactedAttributeCount += 1;
            spanRedactedAttributeCount += 1;
            redactedAttributeBytes += Buffer.byteLength(
              JSON.stringify(attribute),
            );
          } else {
            const stringValue = attribute?.value?.stringValue;
            if (
              isRecord(attribute) &&
              BOUNDED_SQL_ATTRIBUTE_KEYS.has(attribute.key) &&
              typeof stringValue === "string"
            ) {
              const originalBytes = Buffer.byteLength(stringValue);
              if (originalBytes > MAX_SQL_ATTRIBUTE_BYTES) {
                attribute.value.stringValue = truncateUtf8(
                  stringValue,
                  MAX_SQL_ATTRIBUTE_BYTES,
                );
                const retainedBytes = Buffer.byteLength(
                  attribute.value.stringValue,
                );
                truncatedAttributeCount += 1;
                truncatedAttributeBytes += originalBytes - retainedBytes;
                truncatedAttributes.push(
                  `${attribute.key}:${originalBytes}->${retainedBytes}`,
                );
              }
            }
            retainedAttributes.push(attribute);
          }
        }
        if (truncatedAttributes.length > 0) {
          retainedAttributes.push({
            key: TRUNCATED_ATTRIBUTE_MARKER_KEY,
            value: {
              arrayValue: {
                values: truncatedAttributes.map((stringValue) => ({
                  stringValue,
                })),
              },
            },
          });
        }
        span.attributes = retainedAttributes;
        if (spanRedactedAttributeCount > 0) {
          const existingDroppedCount = Number(span.droppedAttributesCount);
          span.droppedAttributesCount =
            (Number.isInteger(existingDroppedCount) && existingDroppedCount >= 0
              ? existingDroppedCount
              : 0) + spanRedactedAttributeCount;
        }
      }
    }
  }

  return {
    redactedAttributeCount,
    redactedAttributeBytes,
    truncatedAttributeCount,
    truncatedAttributeBytes,
  };
};

const findFiles = async (root, fileName) => {
  const matches = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile() && entry.name === fileName) {
        matches.push(path);
      }
    }
  };
  await visit(root);
  return matches.sort();
};

const selectedTraceIdsFromManifests = async (artifactDir) => {
  const traceIds = new Set();
  const manifestPaths = await findFiles(artifactDir, "manifest.json");
  for (const manifestPath of manifestPaths) {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!Array.isArray(manifest.selectedTraceIds)) {
      throw new Error(
        `Trace manifest ${manifestPath} does not contain selectedTraceIds.`,
      );
    }
    for (const traceId of manifest.selectedTraceIds) {
      if (typeof traceId !== "string" || traceId.length !== 32) {
        throw new Error(
          `Trace manifest ${manifestPath} contains invalid trace id ${String(traceId)}.`,
        );
      }
      traceIds.add(traceId);
    }
  }
  return { manifestPaths, traceIds };
};

export const collectSelectedTraceSpans = ({
  tracesData,
  selectedTraceIds,
  payloadsByTraceId,
}) => {
  if (!isRecord(tracesData) || !Array.isArray(tracesData.resourceSpans)) {
    throw new Error("OTLP trace spool line must contain resourceSpans.");
  }

  let rawSpanCount = 0;
  let selectedSpanCount = 0;
  for (const resourceSpans of tracesData.resourceSpans) {
    if (!isRecord(resourceSpans) || !Array.isArray(resourceSpans.scopeSpans)) {
      continue;
    }
    const scopesByTraceId = new Map();
    for (const scopeSpans of resourceSpans.scopeSpans) {
      if (!isRecord(scopeSpans) || !Array.isArray(scopeSpans.spans)) {
        continue;
      }
      rawSpanCount += scopeSpans.spans.length;
      const spansByTraceId = new Map();
      for (const span of scopeSpans.spans) {
        const traceId = isRecord(span) ? span.traceId : undefined;
        if (typeof traceId !== "string" || !selectedTraceIds.has(traceId)) {
          continue;
        }
        const spans = spansByTraceId.get(traceId) ?? [];
        spans.push(span);
        spansByTraceId.set(traceId, spans);
        selectedSpanCount += 1;
      }
      for (const [traceId, spans] of spansByTraceId) {
        const scopes = scopesByTraceId.get(traceId) ?? [];
        scopes.push({ ...scopeSpans, spans });
        scopesByTraceId.set(traceId, scopes);
      }
    }
    for (const [traceId, scopeSpans] of scopesByTraceId) {
      const payload = payloadsByTraceId.get(traceId) ?? {
        resourceSpans: [],
      };
      payload.resourceSpans.push({ ...resourceSpans, scopeSpans });
      payloadsByTraceId.set(traceId, payload);
    }
  }
  return { rawSpanCount, selectedSpanCount };
};

export const prepareSelectedTraceSpool = async ({ spoolPath, artifactDir }) => {
  const { manifestPaths, traceIds: selectedTraceIds } =
    await selectedTraceIdsFromManifests(artifactDir);
  const spoolInfo = await stat(spoolPath);
  const payloadsByTraceId = new Map();
  let rawSpanCount = 0;
  let selectedSpanCount = 0;
  let spoolLineCount = 0;

  const lines = createInterface({
    input: createReadStream(spoolPath, "utf8"),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.trim()) {
      continue;
    }
    spoolLineCount += 1;
    const counts = collectSelectedTraceSpans({
      tracesData: JSON.parse(line),
      selectedTraceIds,
      payloadsByTraceId,
    });
    rawSpanCount += counts.rawSpanCount;
    selectedSpanCount += counts.selectedSpanCount;
  }

  const missingTraceIds = [...selectedTraceIds].filter(
    (traceId) => !payloadsByTraceId.has(traceId),
  );
  let redactedAttributeCount = 0;
  let redactedAttributeBytes = 0;
  let truncatedAttributeCount = 0;
  let truncatedAttributeBytes = 0;
  for (const payload of payloadsByTraceId.values()) {
    const sanitization = sanitizeSelectedTraceAttributes(payload);
    redactedAttributeCount += sanitization.redactedAttributeCount;
    redactedAttributeBytes += sanitization.redactedAttributeBytes;
    truncatedAttributeCount += sanitization.truncatedAttributeCount;
    truncatedAttributeBytes += sanitization.truncatedAttributeBytes;
  }
  const selectedPayloads = [...payloadsByTraceId]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([traceId, payload]) => ({ traceId, payload }));
  const outputPath = join(artifactDir, "selected-traces.otlp.jsonl");
  const output = selectedPayloads
    .map(({ payload }) => JSON.stringify(payload))
    .join("\n");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(outputPath, output ? `${output}\n` : "");

  const summary = {
    spoolPath: basename(spoolPath),
    spoolBytes: spoolInfo.size,
    spoolLineCount,
    manifestCount: manifestPaths.length,
    selectedTraceCount: selectedTraceIds.size,
    foundTraceCount: payloadsByTraceId.size,
    missingTraceCount: missingTraceIds.length,
    missingTraceIds,
    rawSpanCount,
    selectedSpanCount,
    redactedAttributeCount,
    redactedAttributeBytes,
    truncatedAttributeCount,
    truncatedAttributeBytes,
    outputPath: basename(outputPath),
    outputBytes: Buffer.byteLength(output ? `${output}\n` : ""),
  };
  await writeFile(
    join(artifactDir, "selected-traces-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );

  if (missingTraceIds.length > 0) {
    throw new Error(
      `${missingTraceIds.length}/${selectedTraceIds.size} selected traces were absent from the local OTLP spool.`,
    );
  }
  return summary;
};

const requiredArgument = (name) => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  if (!value) {
    throw new Error(`${name} is required.`);
  }
  return resolve(value);
};

const main = async () => {
  const summary = await prepareSelectedTraceSpool({
    spoolPath: requiredArgument("--spool"),
    artifactDir: requiredArgument("--artifact-dir"),
  });
  console.log(
    `Prepared ${summary.foundTraceCount} selected traces (${summary.selectedSpanCount}/${summary.rawSpanCount} spans, ${summary.outputBytes}/${summary.spoolBytes} bytes).`,
  );
  if (process.env.GITHUB_STEP_SUMMARY) {
    await writeFile(
      process.env.GITHUB_STEP_SUMMARY,
      [
        "## Selected trace spool",
        "",
        `- selected traces: ${summary.foundTraceCount}/${summary.selectedTraceCount}`,
        `- selected spans: ${summary.selectedSpanCount}/${summary.rawSpanCount}`,
        `- selected bytes: ${summary.outputBytes}/${summary.spoolBytes}`,
        `- redacted span attributes: ${summary.redactedAttributeCount} (${summary.redactedAttributeBytes} bytes)`,
        `- truncated SQL attributes: ${summary.truncatedAttributeCount} (${summary.truncatedAttributeBytes} bytes removed)`,
        `- artifact: \`${relative(process.cwd(), summary.outputPath)}\``,
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
