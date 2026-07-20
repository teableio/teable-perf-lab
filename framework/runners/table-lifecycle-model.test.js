import assert from "node:assert/strict";
import test from "node:test";
import {
  buildLifecycleExecutionSamples,
  getLifecycleFixtureCount,
} from "./table-lifecycle-model.ts";

test("restore-style lifecycle builds one fixture for many samples", () => {
  assert.equal(getLifecycleFixtureCount(10, true), 1);

  const fixture = { iteration: 1, fixtureId: "fixture-1" };
  const samples = buildLifecycleExecutionSamples({
    fixtureSamples: [fixture],
    sampleCount: 3,
    reuseFixtureAcrossSamples: true,
  });

  assert.deepEqual(
    samples.map(({ iteration, fixtureId }) => ({ iteration, fixtureId })),
    [
      { iteration: 1, fixtureId: "fixture-1" },
      { iteration: 2, fixtureId: "fixture-1" },
      { iteration: 3, fixtureId: "fixture-1" },
    ],
  );
});

test("non-reusable lifecycle keeps one fixture per sample", () => {
  const fixtures = [
    { iteration: 1, fixtureId: "fixture-1" },
    { iteration: 2, fixtureId: "fixture-2" },
  ];

  assert.equal(getLifecycleFixtureCount(2, false), 2);
  assert.equal(
    buildLifecycleExecutionSamples({
      fixtureSamples: fixtures,
      sampleCount: 2,
      reuseFixtureAcrossSamples: false,
    }),
    fixtures,
  );
});

test("lifecycle sample model rejects invalid counts and incomplete pools", () => {
  assert.throws(() => getLifecycleFixtureCount(0, true), /positive integer/);
  assert.throws(
    () =>
      buildLifecycleExecutionSamples({
        fixtureSamples: [],
        sampleCount: 3,
        reuseFixtureAcrossSamples: true,
      }),
    /fixture count mismatch/i,
  );
});
