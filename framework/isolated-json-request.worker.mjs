import { performance } from "node:perf_hooks";
import { parentPort, workerData } from "node:worker_threads";

const getRecordIds = (data) => {
  const records = Array.isArray(data)
    ? data
    : data && typeof data === "object" && Array.isArray(data.records)
      ? data.records
      : [];
  return records
    .map((record) =>
      record && typeof record === "object" && typeof record.id === "string"
        ? record.id
        : undefined,
    )
    .filter(Boolean);
};

const execute = async () => {
  const startedAt = performance.now();
  const response = await fetch(workerData.url, {
    method: workerData.method,
    headers: workerData.headers,
    body:
      workerData.body === undefined
        ? undefined
        : JSON.stringify(workerData.body),
  });
  const responseText = await response.text();
  let data;
  try {
    data = responseText ? JSON.parse(responseText) : null;
  } catch (error) {
    throw new Error(
      `Isolated HTTP response was not valid JSON (status ${response.status}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const durationMs = performance.now() - startedAt;

  if (!response.ok) {
    throw new Error(
      `Isolated HTTP request failed with status ${response.status}: ${responseText.slice(
        0,
        500,
      )}`,
    );
  }

  if (workerData.responseMode !== "recordIds") {
    throw new Error(
      `Unsupported isolated HTTP response mode: ${String(
        workerData.responseMode,
      )}`,
    );
  }

  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    durationMs,
    recordIds: getRecordIds(data),
  };
};

try {
  const response = await execute();
  parentPort?.postMessage({ ok: true, response });
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    error:
      error instanceof Error ? error.stack || error.message : String(error),
  });
}
