import { randomUUID } from "node:crypto";
import {
  axios,
  deleteSelectionOperationEventSchema,
  deleteSelectionOperationSnapshotSchema,
  isDeleteSelectionOperationTerminal,
  X_CANARY_HEADER,
} from "@teable/openapi";
import type { IDeleteSelectionOperationSnapshot } from "@teable/openapi";
import { assertEngineRouting, type EngineRouting } from "../routing";
import { setTimeout as delay } from "node:timers/promises";
import {
  buildPerfTraceHeaders,
  recordPerfTraceRefFromHeaders,
  withPerfTraceStep,
} from "../trace-collector";
import type { PerfCase, PerfRunContext } from "../types";
import { pokeWatchdogActivity } from "../watchdog";

export interface DurableDeleteResult {
  operationId: string;
  totalCount: number;
  deletedCount: number;
  progressEventCount: number;
  status: number;
  observerStatus?: number;
  snapshot: IDeleteSelectionOperationSnapshot;
  routing: EngineRouting & { canaryHeader: string };
  trace: { traceparent?: string };
  timingProfile: string;
  wire: { create: string; observe: string; status: string; selection: string };
  traceSteps: { create: string; observer: string; status: string };
}
export const DELETE_OPERATION_TIMING_PROFILE = "v2-durable-delete-total-ready";

export class DeleteOperationObservationError extends Error {
  readonly snapshot?: IDeleteSelectionOperationSnapshot;
  constructor(
    message: string,
    snapshot?: IDeleteSelectionOperationSnapshot,
    cause?: unknown,
  ) {
    super(message, cause instanceof Error ? { cause } : undefined);
    this.snapshot = snapshot;
    this.name = "DeleteOperationObservationError";
  }
}

export const assertDeleteOperationReady = (
  snapshot: IDeleteSelectionOperationSnapshot,
  expectedCount: number,
) => {
  if (
    snapshot.status !== "succeeded" ||
    snapshot.totalCount !== expectedCount ||
    snapshot.processedCount !== expectedCount ||
    snapshot.deletedCount !== expectedCount ||
    snapshot.failedCount !== 0 ||
    snapshot.error ||
    snapshot.effectsStatus !== "settled" ||
    snapshot.pendingEffectCount !== 0 ||
    snapshot.failedEffectCount !== 0
  ) {
    throw new DeleteOperationObservationError(
      `Deletion did not fully converge: ${JSON.stringify(snapshot)}`,
      snapshot,
    );
  }
};

// The one POST starts execution. Every subsequent request is observation only;
// neither a transport error nor EOF authorizes another mutation.
export const deleteAllRowsDurably = async ({
  tableId,
  viewId,
  expectedCount,
  stepId,
  perfCase,
  context,
  windowId,
  timeoutMs = 120_000,
}: {
  tableId: string;
  viewId: string;
  expectedCount: number;
  stepId: string;
  perfCase: PerfCase;
  context: PerfRunContext;
  windowId: string;
  timeoutMs?: number;
}): Promise<DurableDeleteResult> => {
  if (context.engine !== "v2")
    throw new Error("Durable deletion requires explicit V2 intent");
  const operationId = randomUUID();
  const operationUrl = `/table/${tableId}/selection/delete-operations`;
  const statusUrl = `${operationUrl}/${operationId}`;
  const observerUrl = axios.getUri({
    baseURL: axios.defaults.baseURL || "/api",
    url: `${statusUrl}/stream`,
  });
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = context.signal
    ? AbortSignal.any([context.signal, timeoutSignal])
    : timeoutSignal;
  const headers = {
    ...Object.fromEntries(
      Object.entries(axios.defaults.headers.common).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    ),
    ...(context.cookie ? { Cookie: context.cookie } : {}),
    "X-Window-Id": windowId,
    [X_CANARY_HEADER]: "true",
  };
  let latest: IDeleteSelectionOperationSnapshot | undefined;
  const accept = (raw: unknown) => {
    const snapshot = deleteSelectionOperationSnapshotSchema.parse(raw);
    if (snapshot.operationId !== operationId || snapshot.tableId !== tableId) {
      throw new DeleteOperationObservationError(
        "Deletion scope mismatch",
        snapshot,
      );
    }
    if (latest && snapshot.revision < latest.revision) {
      throw new DeleteOperationObservationError(
        "Deletion revision regressed",
        snapshot,
      );
    }
    latest = snapshot;
    return snapshot;
  };
  try {
    const created = await withPerfTraceStep(
      context,
      perfCase,
      `${stepId}-create-execution`,
      () =>
        axios.post(
          operationUrl,
          {
            operationId,
            viewId,
            selection: { kind: "all" },
          },
          { headers, signal },
        ),
    );
    if (created.status !== 201)
      throw new Error(`Deletion creation returned HTTP ${created.status}`);
    const routing = assertEngineRouting(context, created.headers, {
      feature: "deleteRecord",
      operation: "createDeleteSelectionOperation",
    });
    const initial = accept(created.data);
    let progressEventCount = 0;
    let observerStatus: number | undefined;
    if (!isDeleteSelectionOperationTerminal(initial)) {
      await withPerfTraceStep(
        context,
        perfCase,
        `${stepId}-observe-readonly`,
        async () => {
          const response = await fetch(observerUrl, {
            method: "GET",
            credentials: "include",
            signal,
            headers: {
              ...headers,
              Accept: "text/event-stream",
              ...buildPerfTraceHeaders(
                context,
                perfCase,
                `${stepId}-observe-readonly`,
              ),
            },
          });
          observerStatus = response.status;
          recordPerfTraceRefFromHeaders({
            context,
            perfCase,
            stepId: `${stepId}-observe-readonly`,
            headers: Object.fromEntries(response.headers.entries()),
            method: "GET",
            url: observerUrl,
            status: response.status,
          });
          if (response.status !== 200) {
            await response.body?.cancel();
            throw new DeleteOperationObservationError(
              `Deletion observation returned HTTP ${response.status}`,
              latest,
            );
          }
          const reader = response.body?.getReader();
          if (!reader)
            throw new DeleteOperationObservationError(
              "Deletion observation has no body",
              latest,
            );
          const decoder = new TextDecoder();
          let buffer = "";
          const consume = (line: string) => {
            if (!line.startsWith("data:")) return false;
            const data = line.slice(5).trim();
            if (!data || data === "[DONE]") return false;
            const raw = JSON.parse(data);
            if (raw.id === "connect" || raw.id === "complete") return false;
            const event = deleteSelectionOperationEventSchema.parse(raw);
            accept(event);
            progressEventCount += 1;
            return isDeleteSelectionOperationTerminal(event);
          };
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (!done) pokeWatchdogActivity();
              buffer += done
                ? decoder.decode()
                : decoder.decode(value, { stream: true });
              let newline: number;
              while ((newline = buffer.indexOf("\n")) !== -1) {
                if (newline > 65536)
                  throw new Error("Deletion observation frame exceeds limit");
                const terminal = consume(buffer.slice(0, newline));
                buffer = buffer.slice(newline + 1);
                if (terminal) return;
              }
              if (buffer.length > 65536)
                throw new Error("Deletion observation frame exceeds limit");
              if (done) {
                if (buffer.trim()) consume(buffer);
                return;
              }
            }
          } finally {
            try {
              await reader.cancel();
            } catch {
              // Preserve the observation failure if the stream already errored.
            } finally {
              reader.releaseLock();
            }
          }
        },
      );
    }
    const readStatus = async () => {
      const response = await withPerfTraceStep(
        context,
        perfCase,
        `${stepId}-status-readonly`,
        () => axios.get(statusUrl, { headers, signal }),
      );
      if (response.status !== 200)
        throw new Error(`Deletion status returned HTTP ${response.status}`);
      return accept(response.data);
    };
    // Always confirm durable status, including after EOF. A still-running operation
    // fails observation; it is not re-created or implicitly resumed.
    let snapshot = await readStatus();
    if (!isDeleteSelectionOperationTerminal(snapshot)) {
      throw new DeleteOperationObservationError(
        "Deletion observation disconnected before terminal status",
        snapshot,
      );
    }
    while (
      snapshot.status === "succeeded" &&
      !snapshot.error &&
      snapshot.failedCount === 0 &&
      snapshot.effectsStatus === "pending" &&
      snapshot.failedEffectCount === 0
    ) {
      await delay(250, undefined, { signal });
      pokeWatchdogActivity();
      snapshot = await readStatus();
    }
    assertDeleteOperationReady(snapshot, expectedCount);
    return {
      operationId,
      totalCount: snapshot.totalCount,
      deletedCount: snapshot.deletedCount,
      progressEventCount,
      status: created.status,
      observerStatus,
      snapshot,
      routing: { ...routing, canaryHeader: headers[X_CANARY_HEADER] },
      trace: { traceparent: created.headers.traceparent as string | undefined },
      timingProfile: DELETE_OPERATION_TIMING_PROFILE,
      wire: {
        create: "POST",
        observe: "GET SSE",
        status: "GET",
        selection: "all",
      },
      traceSteps: {
        create: `${stepId}-create-execution`,
        observer: `${stepId}-observe-readonly`,
        status: `${stepId}-status-readonly`,
      },
    };
  } catch (error) {
    if (error instanceof DeleteOperationObservationError) throw error;
    throw new DeleteOperationObservationError(
      error instanceof Error ? error.message : String(error),
      latest,
      error,
    );
  }
};
