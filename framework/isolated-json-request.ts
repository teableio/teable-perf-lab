import { Worker } from "node:worker_threads";

export interface IsolatedJsonRequest {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: unknown;
  responseMode: "recordIds";
}

export interface IsolatedJsonResponse {
  status: number;
  headers: Record<string, string>;
  durationMs: number;
  recordIds: string[];
}

type WorkerResult =
  | {
      ok: true;
      response: IsolatedJsonResponse;
    }
  | {
      ok: false;
      error: string;
    };

export const runIsolatedJsonRequest = (
  request: IsolatedJsonRequest,
): Promise<IsolatedJsonResponse> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(
      new URL("./isolated-json-request.worker.mjs", import.meta.url),
      { workerData: request },
    );
    let settled = false;

    worker.once("message", (result: WorkerResult) => {
      settled = true;
      void worker.terminate();
      if (result.ok === true) {
        resolve(result.response);
      } else {
        reject(new Error(result.error));
      }
    });
    worker.once("error", (error) => {
      settled = true;
      reject(error);
    });
    worker.once("exit", (code) => {
      if (!settled) {
        reject(
          new Error(
            `Isolated HTTP worker exited before returning a result (code ${code})`,
          ),
        );
      }
    });
  });
