import {
  compactTraceManifest,
  jsonText,
  numberOrUndefined,
  primaryMetricValue,
  stringOrUndefined,
} from "./perf-artifact-read-model.mjs";

const REQUIRED_FIELD_NAMES = [
  "Run Key",
  "Run ID",
  "Run Attempt",
  "Job ID",
  "Workflow",
  "Teable EE Ref",
  "Commit SHA",
  "Case ID",
  "Case Title",
  "Engine",
  "Result",
  "Started At",
  "Finished At",
  "Duration Ms",
  "Threshold Passed",
  "Primary Metric",
  "Primary Metric Value",
  "Primary Threshold",
  "Trace Ref Count",
  "Saved Trace Count",
  "Failed Trace Count",
  "Artifact Name",
  "Artifact URL",
  "Run URL",
  "Trace URL",
  "Manifest Path",
  "Metrics JSON",
  "Thresholds JSON",
  "Phases JSON",
  "Trace Manifest JSON",
  "Summary Markdown",
  "Error",
];

const RUN_KEY_FIELD_ID = "fldBtUJjGxgsPWsqLua";
const PERFORMANCE_TRACK_READ_PAGE_SIZE = 1_000;

export const DEFAULT_PERFORMANCE_TRACK_WRITE_MAX_BYTES = 512 * 1024;

const PERFORMANCE_TRACK_WRITE_EMPTY_BODY_BYTES = Buffer.byteLength(
  JSON.stringify({ fieldKeyType: "name", typecast: true, records: [] }),
);

export const chunkPerformanceTrackWriteRecords = (
  records,
  maxBytes = DEFAULT_PERFORMANCE_TRACK_WRITE_MAX_BYTES,
) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
    throw new Error(`Invalid Performance Track write byte limit: ${maxBytes}`);
  }

  const batches = [];
  let batch = [];
  let batchBytes = PERFORMANCE_TRACK_WRITE_EMPTY_BODY_BYTES;

  for (const [index, record] of records.entries()) {
    const recordBytes = Buffer.byteLength(JSON.stringify(record));
    let nextBytes = batchBytes + recordBytes + (batch.length > 0 ? 1 : 0);

    if (batch.length > 0 && nextBytes > maxBytes) {
      batches.push(batch);
      batch = [];
      batchBytes = PERFORMANCE_TRACK_WRITE_EMPTY_BODY_BYTES;
      nextBytes = batchBytes + recordBytes;
    }

    if (nextBytes > maxBytes) {
      const recordLabel =
        record.fields?.["Run Key"] ?? record.id ?? `at index ${index}`;
      throw new Error(
        `Performance Track write record ${recordLabel} exceeds ${maxBytes} bytes`,
      );
    }

    batch.push(record);
    batchBytes = nextBytes;
  }

  if (batch.length > 0) {
    batches.push(batch);
  }

  return batches;
};

const compactFields = (fields) =>
  Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  );

const parseDate = (value) => {
  const time = Date.parse(value ?? "");
  return Number.isFinite(time) ? time : undefined;
};

const currentRunIds = (payloads, currentRunId) => {
  const ids = new Set();
  const add = (value) => {
    if (!value) {
      return;
    }
    const id = String(value);
    ids.add(id);
    const [runId] = id.split("-");
    if (runId) {
      ids.add(runId);
    }
  };

  add(currentRunId);
  for (const payload of payloads) {
    add(payload.runId);
  }
  return ids;
};

const comparisonTargets = (payloads) => {
  const grouped = new Map();
  for (const payload of payloads) {
    const entry = grouped.get(payload.caseId) ?? {};
    entry[payload.engine] = payload;
    grouped.set(payload.caseId, entry);
  }

  return [...grouped.entries()]
    .filter(([, engines]) => engines.v1?.result === "skipped")
    .map(([caseId, engines]) => engines.v2 ?? { caseId })
    .filter(
      (payload) =>
        payload.engine === "v2" &&
        payload.result !== "skipped" &&
        Number.isFinite(primaryMetricValue(payload)),
    );
};

export const buildPerformanceTrackResultRecord = ({
  payload,
  traceManifest,
  summaryMarkdown,
  context,
}) => {
  const runId = context.runId || payload.runId;
  const runAttempt = context.runAttempt || "0";
  const engine = payload.engine || context.engine || "local";
  const runKey = [runId, runAttempt, payload.caseId, engine].join("-");
  const thresholds = Array.isArray(payload.thresholds)
    ? payload.thresholds
    : [];
  const primaryThreshold = thresholds[0];
  const traces = payload.details?.observability?.traces ?? {};
  const traceManifestPath =
    stringOrUndefined(traces.manifestPath) ||
    stringOrUndefined(traceManifest?.manifestPath);

  return {
    runKey,
    fields: compactFields({
      "Run Key": runKey,
      "Run ID": stringOrUndefined(runId),
      "Run Attempt": numberOrUndefined(runAttempt),
      "Job ID": stringOrUndefined(context.jobId),
      Workflow: stringOrUndefined(context.workflow),
      "Teable EE Ref": stringOrUndefined(context.teableEeRef),
      "Commit SHA": stringOrUndefined(context.commitSha),
      "Case ID": stringOrUndefined(payload.caseId),
      "Case Title": stringOrUndefined(payload.title),
      Engine: stringOrUndefined(engine),
      Result: stringOrUndefined(payload.result),
      "Started At": stringOrUndefined(payload.startedAt),
      "Finished At": stringOrUndefined(payload.finishedAt),
      "Duration Ms": numberOrUndefined(payload.durationMs),
      "Threshold Passed":
        thresholds.length > 0
          ? thresholds.every((threshold) => threshold.passed)
          : undefined,
      "Primary Metric": stringOrUndefined(primaryThreshold?.metric),
      "Primary Metric Value": numberOrUndefined(primaryThreshold?.actual),
      "Primary Threshold": numberOrUndefined(primaryThreshold?.max),
      "Trace Ref Count": numberOrUndefined(traces.traceRefCount),
      "Saved Trace Count": numberOrUndefined(traces.savedTraceCount),
      "Failed Trace Count": numberOrUndefined(traces.failedTraceCount),
      "Artifact Name": stringOrUndefined(context.artifactName),
      "Artifact URL": stringOrUndefined(context.artifactUrl),
      "Run URL": stringOrUndefined(context.runUrl),
      "Trace URL": stringOrUndefined(context.traceUrl),
      "Manifest Path": stringOrUndefined(traceManifestPath),
      "Metrics JSON": jsonText(payload.metrics),
      "Thresholds JSON": jsonText(payload.thresholds),
      "Phases JSON": jsonText(payload.phases),
      "Trace Manifest JSON": jsonText(compactTraceManifest(traceManifest)),
      "Summary Markdown": summaryMarkdown,
      Error: payload.error ? jsonText(payload.error) : undefined,
    }),
  };
};

export const createTeablePerformanceTrackAdapter = ({
  request,
  tableId,
  maxWriteBytes = DEFAULT_PERFORMANCE_TRACK_WRITE_MAX_BYTES,
}) => ({
  async listFields() {
    return request({ method: "GET", path: `/table/${tableId}/field` });
  },
  async findRecords({ filter, take, skip, projection, orderBy }) {
    const params = new URLSearchParams({
      fieldKeyType: "name",
      take: String(take),
      filter: JSON.stringify(filter),
    });
    if (skip != null) {
      params.set("skip", String(skip));
    }
    if (projection) {
      params.set("projection", projection);
    }
    if (orderBy) {
      params.set("orderBy", JSON.stringify(orderBy));
    }
    const data = await request({
      method: "GET",
      path: `/table/${tableId}/record?${params.toString()}`,
    });
    return data?.records ?? [];
  },
  async updateRecords(records) {
    for (const batch of chunkPerformanceTrackWriteRecords(
      records,
      maxWriteBytes,
    )) {
      await request({
        method: "PATCH",
        path: `/table/${tableId}/record`,
        body: { fieldKeyType: "name", typecast: true, records: batch },
      });
    }
  },
  async createRecords(records) {
    const createdRecords = [];
    for (const batch of chunkPerformanceTrackWriteRecords(
      records,
      maxWriteBytes,
    )) {
      const data = await request({
        method: "POST",
        path: `/table/${tableId}/record`,
        body: { fieldKeyType: "name", typecast: true, records: batch },
      });
      const createdBatch = data?.records ?? [];
      if (createdBatch.length !== batch.length) {
        throw new Error(
          `Teable created ${createdBatch.length} Performance Track records; expected ${batch.length}`,
        );
      }
      createdRecords.push(...createdBatch);
    }
    return createdRecords;
  },
});

export const createInMemoryPerformanceTrackAdapter = ({
  fields = REQUIRED_FIELD_NAMES.map((name) => ({ name })),
  records = [],
} = {}) => {
  const storedRecords = records.map((record) => ({
    ...record,
    fields: { ...record.fields },
  }));
  const fieldName = (fieldId) =>
    fieldId === RUN_KEY_FIELD_ID ? "Run Key" : fieldId;

  return {
    async listFields() {
      return fields;
    },
    async findRecords({ filter, take, skip = 0, orderBy }) {
      let matches = storedRecords.filter((record) =>
        (filter?.filterSet ?? []).every(
          (condition) =>
            record.fields?.[fieldName(condition.fieldId)] === condition.value,
        ),
      );
      for (const order of [...(orderBy ?? [])].reverse()) {
        matches = [...matches].sort((left, right) => {
          const leftValue = left.fields?.[fieldName(order.fieldId)];
          const rightValue = right.fields?.[fieldName(order.fieldId)];
          const direction = order.order === "desc" ? -1 : 1;
          return (
            String(leftValue ?? "").localeCompare(String(rightValue ?? "")) *
            direction
          );
        });
      }
      return matches.slice(skip, skip + take);
    },
    async updateRecords(updates) {
      for (const update of updates) {
        const record = storedRecords.find((item) => item.id === update.id);
        if (!record) {
          throw new Error(
            `Unknown in-memory Performance Track record ${update.id}`,
          );
        }
        record.fields = { ...record.fields, ...update.fields };
      }
    },
    async createRecords(newRecords) {
      return newRecords.map((record) => {
        const created = {
          id: `rec-memory-${storedRecords.length + 1}`,
          fields: { ...record.fields },
        };
        storedRecords.push(created);
        return created;
      });
    },
    snapshot() {
      return storedRecords.map((record) => ({
        ...record,
        fields: { ...record.fields },
      }));
    },
  };
};

const requireRunKey = (fields) => {
  const runKey = fields?.["Run Key"];
  if (typeof runKey !== "string" || !runKey.trim()) {
    throw new Error(
      'Performance Track result requires a non-empty "Run Key" field',
    );
  }
  return runKey;
};

const normalizeRunContext = ({ runId, runAttempt }) => {
  const normalizedRunId = stringOrUndefined(runId);
  const normalizedRunAttempt = numberOrUndefined(runAttempt);
  if (!normalizedRunId || !Number.isFinite(normalizedRunAttempt)) {
    throw new Error(
      "Performance Track batch upsert requires Run ID and Run Attempt",
    );
  }
  return { runId: normalizedRunId, runAttempt: normalizedRunAttempt };
};

const assertDesiredRunRecords = ({ records, runId, runAttempt }) => {
  const seen = new Set();
  for (const record of records) {
    const runKey = requireRunKey(record.fields);
    if (seen.has(runKey)) {
      throw new Error(`Duplicate desired Run Key: ${runKey}`);
    }
    seen.add(runKey);

    if (
      String(record.fields?.["Run ID"] ?? "") !== runId ||
      numberOrUndefined(record.fields?.["Run Attempt"]) !== runAttempt
    ) {
      throw new Error(
        `Performance Track result ${runKey} does not match run ${runId} attempt ${runAttempt}`,
      );
    }
  }
};

const listExistingRunRecords = async (adapter, { runId, runAttempt }) => {
  const records = [];
  for (
    let skip = 0;
    ;
    skip += PERFORMANCE_TRACK_READ_PAGE_SIZE
  ) {
    const page = await adapter.findRecords({
      take: PERFORMANCE_TRACK_READ_PAGE_SIZE,
      skip,
      projection: "Run Key",
      filter: {
        conjunction: "and",
        filterSet: [
          { fieldId: "Run ID", operator: "is", value: runId },
          { fieldId: "Run Attempt", operator: "is", value: runAttempt },
        ],
      },
    });
    records.push(...page);
    if (page.length < PERFORMANCE_TRACK_READ_PAGE_SIZE) {
      return records;
    }
  }
};

export const createPerformanceTrackRecordModule = (adapter) => ({
  async assertContract() {
    const fields = await adapter.listFields();
    const names = new Set((fields ?? []).map((field) => field.name));
    const missing = REQUIRED_FIELD_NAMES.filter((name) => !names.has(name));
    if (missing.length > 0) {
      throw new Error(`Missing Teable report fields: ${missing.join(", ")}`);
    }
  },

  async upsertResult({ fields }) {
    const runKey = requireRunKey(fields);
    const records = await adapter.findRecords({
      take: 1,
      projection: "Run Key",
      filter: {
        conjunction: "and",
        filterSet: [
          {
            fieldId: RUN_KEY_FIELD_ID,
            operator: "is",
            value: runKey,
          },
        ],
      },
    });
    const existing = records.find(
      (record) => record.fields?.["Run Key"] === runKey,
    );

    if (existing?.id) {
      await adapter.updateRecords([{ id: existing.id, fields }]);
      return { action: "updated", recordId: existing.id };
    }

    const [created] = await adapter.createRecords([{ fields }]);
    return { action: "created", recordId: created?.id };
  },

  async upsertResults({ records, runId, runAttempt }) {
    const runContext = normalizeRunContext({ runId, runAttempt });
    assertDesiredRunRecords({ records, ...runContext });
    if (records.length === 0) {
      return { total: 0, created: [], updated: [] };
    }

    const existingRecords = await listExistingRunRecords(adapter, runContext);
    const existingByRunKey = new Map();
    for (const existing of existingRecords) {
      const runKey = requireRunKey(existing.fields);
      if (existingByRunKey.has(runKey)) {
        throw new Error(`Duplicate existing Run Key: ${runKey}`);
      }
      existingByRunKey.set(runKey, existing);
    }

    const creates = [];
    const updates = [];
    for (const record of records) {
      const runKey = record.fields["Run Key"];
      const existing = existingByRunKey.get(runKey);
      if (existing?.id) {
        updates.push({ id: existing.id, fields: record.fields });
      } else {
        creates.push({ fields: record.fields });
      }
    }

    if (updates.length > 0) {
      await adapter.updateRecords(updates);
    }
    const createdRecords =
      creates.length > 0 ? await adapter.createRecords(creates) : [];

    return {
      total: records.length,
      updated: updates.map((record) => ({
        runKey: record.fields["Run Key"],
        recordId: record.id,
      })),
      created: creates.map((record, index) => ({
        runKey: record.fields["Run Key"],
        recordId: createdRecords[index]?.id,
      })),
    };
  },

  async comparisonBaselines({ payloads, currentRunId }) {
    const excludedRunIds = currentRunIds(payloads, currentRunId);
    const baselines = {};

    for (const payload of comparisonTargets(payloads)) {
      const metric = payload.thresholds?.[0]?.metric;
      if (!metric) {
        continue;
      }
      const records = await adapter.findRecords({
        take: 20,
        filter: {
          conjunction: "and",
          filterSet: [
            { fieldId: "Case ID", operator: "is", value: payload.caseId },
            { fieldId: "Engine", operator: "is", value: payload.engine },
            { fieldId: "Result", operator: "is", value: "pass" },
            {
              fieldId: "Primary Metric",
              operator: "is",
              value: metric,
            },
          ],
        },
        orderBy: [{ fieldId: "Finished At", order: "desc" }],
      });
      const baselineRecord = [...records]
        .sort(
          (left, right) =>
            (parseDate(right.fields?.["Finished At"]) ?? 0) -
            (parseDate(left.fields?.["Finished At"]) ?? 0),
        )
        .find((record) => {
          const runId = String(record.fields?.["Run ID"] ?? "");
          const value = numberOrUndefined(
            record.fields?.["Primary Metric Value"],
          );
          return (
            runId &&
            !excludedRunIds.has(runId) &&
            Number.isFinite(value) &&
            value > 0
          );
        });
      const value = numberOrUndefined(
        baselineRecord?.fields?.["Primary Metric Value"],
      );
      if (!Number.isFinite(value) || value <= 0) {
        continue;
      }

      baselines[payload.caseId] = {
        label: "Baseline",
        metric,
        runId: String(baselineRecord.fields?.["Run ID"] ?? ""),
        value,
      };
    }

    return baselines;
  },
});
