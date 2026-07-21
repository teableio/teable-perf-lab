import assert from "node:assert/strict";
import test from "node:test";

import { normalizePerfError, toPerfTestFailure } from "./perf-error.ts";

test("normalizes Error values for artifacts", () => {
  const error = new Error("seed request failed");
  error.name = "AxiosError";

  assert.deepEqual(normalizePerfError(error), {
    name: "AxiosError",
    message: "seed request failed",
    stack: error.stack,
  });
});

test("rethrows a plain Error without Axios request payload properties", () => {
  const error = new Error("seed request failed");
  error.name = "AxiosError";
  error.config = { data: "large fixture payload" };
  error.response = { data: "server response" };

  const failure = toPerfTestFailure(error);

  assert.equal(failure.name, "AxiosError");
  assert.equal(failure.message, "seed request failed");
  assert.equal(failure.stack, error.stack);
  assert.deepEqual(Object.keys(failure).sort(), ["name"]);
  assert.equal("config" in failure, false);
  assert.equal("response" in failure, false);
});

test("normalizes non-Error failures", () => {
  assert.deepEqual(normalizePerfError("seed request failed"), {
    message: "seed request failed",
  });
  assert.equal(
    toPerfTestFailure("seed request failed").message,
    "seed request failed",
  );
});
