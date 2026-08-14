import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_RESPONSE_CHARS,
  describePerfError,
  normalizePerfError,
  toPerfTestFailure,
} from "./perf-error.ts";

test("normalizes Error values for artifacts", () => {
  const error = new Error("seed request failed");
  error.name = "AxiosError";

  assert.deepEqual(normalizePerfError(error), {
    name: "AxiosError",
    message: "seed request failed",
    stack: error.stack,
  });
});

test("keeps what the server said", () => {
  // The failure this exists for. Axios reports every server error as the same
  // sentence, and eleven consecutive CI failures of five cases carried nothing
  // but that sentence.
  const error = new Error("Request failed with status code 500");
  error.name = "AxiosError";
  error.response = {
    status: 500,
    data: {
      statusCode: 500,
      message: "out of shared memory",
      error: "Internal Server Error",
    },
  };

  const normalized = normalizePerfError(error);
  assert.equal(normalized.status, 500);
  assert.match(normalized.response, /out of shared memory/);
  assert.match(
    describePerfError(normalized),
    /Request failed with status code 500 — server said: .*out of shared memory/,
  );
});

test("reads only the response, never the request", () => {
  // `config` and `request` carry the whole request body — on a 1,000-record
  // update that is the payload this harness exists to send, and the reason the
  // axios error was stripped in the first place.
  const error = new Error("Request failed with status code 500");
  error.config = { data: "x".repeat(500_000) };
  error.request = { body: "y".repeat(500_000) };
  error.response = { status: 500, data: "short" };

  const normalized = normalizePerfError(error);
  assert.equal(normalized.response, "short");
  assert.equal(JSON.stringify(normalized).includes("xxxx"), false);
  assert.equal(JSON.stringify(normalized).includes("yyyy"), false);
});

test("truncates a large body and says it truncated", () => {
  const error = new Error("boom");
  error.response = { status: 500, data: "z".repeat(MAX_RESPONSE_CHARS + 500) };

  const { response } = normalizePerfError(error);
  assert.ok(response.length < MAX_RESPONSE_CHARS + 100);
  assert.match(response, /… \(2500 chars\)$/);
});

test("survives a body that will not serialize", () => {
  const circular = { name: "loop" };
  circular.self = circular;
  const error = new Error("boom");
  error.response = { status: 503, data: circular };

  const normalized = normalizePerfError(error);
  assert.equal(normalized.status, 503);
  assert.equal(typeof normalized.response, "string");
});

test("a failure with no response carries no response fields", () => {
  const error = new Error("connect ECONNREFUSED");
  const normalized = normalizePerfError(error);
  assert.equal("status" in normalized, false);
  assert.equal("response" in normalized, false);
  assert.equal(describePerfError(normalized), "connect ECONNREFUSED");
});

test("an empty body is absent rather than empty", () => {
  const error = new Error("boom");
  error.response = { status: 500, data: "" };
  assert.equal(normalizePerfError(error).response, undefined);
  assert.equal(normalizePerfError(error).status, 500);
});

test("rethrows a plain Error without Axios request payload properties", () => {
  const error = new Error("seed request failed");
  error.name = "AxiosError";
  error.config = { data: "large fixture payload" };
  error.response = { data: "server response" };

  const failure = toPerfTestFailure(error);

  assert.equal(failure.name, "AxiosError");
  // The server's answer reaches the thrown message, which is what CI prints.
  assert.equal(
    failure.message,
    "seed request failed — server said: server response",
  );
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
