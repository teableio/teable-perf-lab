import assert from "node:assert/strict";
import test from "node:test";
import {
  isTransientHttp500,
  retryTransientHttp500,
} from "./transient-http-retry.ts";

const httpError = (status) =>
  Object.assign(new Error(`HTTP ${status}`), {
    response: { status },
  });

test("retries HTTP 500 with exponential backoff", async () => {
  let attempts = 0;
  const delays = [];

  const result = await retryTransientHttp500(
    async () => {
      attempts += 1;
      if (attempts < 4) {
        throw httpError(500);
      }
      return "ok";
    },
    {
      timeoutMs: 15_000,
      initialDelayMs: 250,
      maxDelayMs: 2_000,
      sleepFn: async (delayMs) => {
        delays.push(delayMs);
      },
    },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 4);
  assert.deepEqual(delays, [250, 500, 1_000]);
});

test("does not retry non-500 failures", async () => {
  const error = httpError(503);
  let attempts = 0;

  await assert.rejects(
    retryTransientHttp500(
      async () => {
        attempts += 1;
        throw error;
      },
      {
        timeoutMs: 15_000,
        sleepFn: async () => {
          throw new Error("sleep should not run");
        },
      },
    ),
    (actual) => actual === error,
  );

  assert.equal(attempts, 1);
  assert.equal(isTransientHttp500(error), false);
});

test("stops retrying when the shared budget is exhausted", async () => {
  const error = httpError(500);
  let attempts = 0;

  await assert.rejects(
    retryTransientHttp500(
      async () => {
        attempts += 1;
        throw error;
      },
      {
        timeoutMs: 0,
        sleepFn: async () => {
          throw new Error("sleep should not run");
        },
      },
    ),
    (actual) => actual === error,
  );

  assert.equal(attempts, 1);
  assert.equal(isTransientHttp500(error), true);
});
