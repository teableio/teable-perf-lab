# Compute-time observation spec

Status: proposed. Owner: perf-lab. Target: perf lab v2 metric surface.

## Why

A perf case today reports how long the user waited. It cannot report how much
computing the engine actually did. Those two numbers diverge whenever the
engine changes _how_ computed work is scheduled without changing _how much_
there is.

The concrete trigger is teable-ee `1dd78a15aa` (`feat(v2): split computed update
plans into budget-bounded frontier stages T6526`), which splits one logical
computed run into a chain of continuation outbox tasks. Each stage pays claim +
advisory lock + wake-up latency. Settle wall clock rises; compute volume does
not. Every case measuring settle time reports a regression that no optimization
can fix, and a real compute regression hiding underneath is indistinguishable
from the scheduling tax.

This spec adds a second, scheduling-invariant axis so the two can be told
apart.

## What is measured, and what that number does not mean

The metric is **occupancy time**: the summed wall-clock duration of the engine's
computed-execution spans, regardless of whether they ran back to back or
overlapped.

Occupancy is invariant to serialization. Two tasks that each take 1s sum to 2s
whether they run in parallel or one after the other. That is the property the
metric exists for.

Occupancy is **not** CPU time, and it is **not** perfectly invariant. Three
honest limits, all of which must stay in the case docs:

- Parallelizing contended work inflates each task's wall clock (lock waits,
  event-loop sharing), so occupancy rises even when the work is unchanged. It
  degrades far more slowly than settle time, but it is not a constant.
- Occupancy says nothing about whether the _amount_ of work changed. It is only
  interpretable next to a work-volume control (step counts, estimated
  complexity), which this spec also captures.
- **Occupancy is comparable only within one computed-update mode.** Invariance
  covers rescheduling the same units of work; it does not cover re-cutting the
  work into different units. Splitting one run into N outbox tasks makes each
  task repeat its own setup — load tables, seed dirty records, propagate — so
  the same logical change genuinely burns more machine. Measured on
  `lookup/foreign-select-flip-1of40-fanout100-4k` against `develop`: sync spends
  375.95ms over 4 execute spans, hybrid spends 836.29ms over 16, while
  `computeStepsExecuted` stays flat at 18 vs 16. That 2.2x is a real cost, not
  an artifact — but it means a baseline captured in one mode must never be
  compared against a run in the other. Any stored compute baseline has to carry
  its mode the way `full-run-comparison-model.mjs` already carries the primary
  metric name, and reject the comparison on mismatch rather than report a
  fabricated 2.2x regression.

## Signal: exactly one span name per sum

Two spans in teable-ee carry the relevant durations, and they **nest** — summing
both double-counts.

| Span                                  | Where                         | Covers                                                                                                                                      |
| ------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `teable.ComputedFieldUpdater.execute` | `ComputedFieldUpdater.ts:526` | One computed execution run. Emitted in **both** sync and hybrid modes.                                                                      |
| `teable.worker.processClaimedTask`    | `ComputedUpdateWorker.ts:771` | One outbox task end to end: claim housekeeping, plan deserialize, locks, the `execute` above, continuation enqueue, `markDone`. Async only. |

`processClaimedTask` is the parent of `execute` on the async path. So:

- The canonical compute number sums **`ComputedFieldUpdater.execute` only**.
- `processClaimedTask` is summed separately and never added to it.

Both spans are already attributed. `ComputedFieldUpdater.ts:550` applies
`toRunSpanAttributes`, which stamps:

- `computed.runId` — stable across a continuation chain, so a chain collapses to
  one logical run.
- `computed.phase` — `full` (sync strategy), `sync` (hybrid's inline leg),
  `async` (worker task). Verified at `SyncInTransactionStrategy` /
  `HybridWithOutboxStrategy.ts:458` / `ComputedUpdateWorker.ts:898,1618`.
- `computed.taskId` — present only on async runs.
- `computed.totalSteps`, `computed.completedStepsBefore`,
  `computed.estimatedComplexity`, `computed.executedStepCount`.

The `phase` split is what makes the decomposition exact:

```
computeInlineMs      = Σ execute where phase ∈ {full, sync}
computeAsyncMs       = Σ execute where phase = async
computeMs            = computeInlineMs + computeAsyncMs
computeTaskMs        = Σ processClaimedTask
computeTaskOverheadMs = computeTaskMs − computeAsyncMs
```

`computeTaskOverheadMs` is the orchestration tax — claim, lock, plan, enqueue,
mark-done, per task. **That is the number that separates "computation got
slower" from "scheduling got more serial."** A stage-splitting change moves
`computeTaskOverheadMs` and `computeTaskCount`, and leaves `computeMs` flat.

## Mechanism: an in-process span sink

The perf spec boots the Nest app in the same process it runs cases in, and
imports the engine's OTel module directly (`perf-lab.e2e-spec.ts:3`). Span data
is therefore available in-process, with no Jaeger round trip and none of the
`PERF_LAB_TRACE_FETCH_*` budget, settle, and breaker machinery that the
evidence path needs.

Attachment point, verified against the installed OTel (`sdk-trace-base@2.2.0`,
`sdk-node@0.201.1`):

- `otelSDK.start()` runs at module-import time (`tracing.ts:413`), so the
  provider exists before any `beforeAll`.
- `NodeSDK` holds `_tracerProvider` (`sdk.js:119,235`).
- `BasicTracerProvider` holds `_activeSpanProcessor`, a `MultiSpanProcessor`
  constructed once (`BasicTracerProvider.js:50`), and every `Tracer` is
  constructed with a **reference to that object** (`BasicTracerProvider.js:55`).
- `MultiSpanProcessor.onEnd` iterates `this._spanProcessors` **on every call**
  (`MultiSpanProcessor.js:48`).

So pushing a processor onto that array at runtime is picked up by every tracer,
including ones already created. There is no public API for this in OTel 2.x
(`addSpanProcessor` was removed), so this is a private-field reach. The repo
already has that precedent in the same file: `getOtelForceFlush()`
(`perf-lab.e2e-spec.ts:88-105`) reaches `sdk._tracerProvider`.

Durations come from `ReadableSpan.startTime` / `.endTime` / `.duration`, all
`HrTime` (`[seconds, nanoseconds]`). Convert to epoch milliseconds with
`hr[0] * 1000 + hr[1] / 1e6` rather than importing `@opentelemetry/core`, so the
sink does not add a resolution dependency on the engine's node_modules layout.

The sink records nothing but the fields it needs, into a bounded ring buffer.
It must not retain `ReadableSpan` objects — they hold resource and scope
references and would pin memory across a 270-case job.

## Attribution: time windows, not AsyncLocalStorage

`withPerfTraceStep` (`framework/trace-collector.ts:695`) uses an
`AsyncLocalStorage`. That works for HTTP request attribution and **will not work
here**: worker spans run on a different async root, outside any ALS context the
runner established. ALS would silently attribute zero async compute.

Attribution is therefore by span **end time** falling inside an explicitly
opened window.

Windows come in two granularities:

1. **Per case, automatic.** `runPerfCase` (`framework/run-perf-case.ts:53`)
   opens a window around `executeRegisteredRunner` and closes it after. Free for
   all ~270 cases, no runner edits.
2. **Per step, opt-in.** A `measureAsyncWithCompute(name, fn)` sibling to
   `measureAsync` (`framework/metrics.ts:36`) that returns the existing
   `Measurement<T>` plus the compute aggregate for that step's window.

The per-case window is too coarse to be the headline number on its own: it
includes fixture preparation. A 20k-record `prepareMs` phase does far more
computing than the mutation the case is actually measuring, and would swamp it.
So per-case is a **health and contamination signal**; the per-step window on
the measured region is the reportable metric.

Two contamination modes must be visible rather than silent:

- **Spill-in.** A span that started before the window opened but ended inside
  it — usually the previous case's compute still draining. Counted as
  `computeSpillInCount` and excluded from the sums.
- **Spill-out.** The window closed while compute was still in flight. Tracked by
  span, not by run: `computed.runId` is stamped with `setAttributes` _after_
  `startSpan`, so it is not yet readable when `onStart` fires. The sink keeps
  the ids of matching spans that started inside the window and have not ended,
  and reports the count as `computeUnsettledSpans`.

A case whose `computeUnsettledSpans` is non-zero is not comparable across runs
and must say so in its artifact.

## Module layout

New files, matching the existing pure-model-plus-`node:test` house style
(`framework/trace-relay-drain.ts` + `framework/trace-relay-drain.test.js`):

| File                                   | Role                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `framework/compute-span-model.ts`      | Pure. Given `ComputeSpanSample[]` and a window, produce `ComputeWindowSummary`. No OTel, no I/O, no clock.                                                   |
| `framework/compute-span-model.test.js` | `node:test` over the model: nesting, phase split, spill-in exclusion, unsettled detection, empty window.                                                     |
| `framework/compute-span-sink.ts`       | Impure. `installComputeSpanSink()` / `uninstallComputeSpanSink()` / `openComputeWindow()` / `closeComputeWindow()`. Owns the OTel reach and the ring buffer. |

`ComputeSpanSample` is deliberately a flat record so the model stays pure and
the test needs no OTel fixtures:

```ts
export type ComputeSpanSample = {
  kind: "execute" | "task";
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  runId?: string;
  taskId?: string;
  phase?: "full" | "sync" | "async";
  executedStepCount?: number;
  estimatedComplexity?: number;
};
```

The span name is normalized to `kind` at the sink boundary so the model never
carries an engine string, and a rename is one constant in
`compute-span-model.ts` with a test behind it.

Edits to existing files:

- `framework/run-perf-case.ts` — open/close the per-case window, merge the
  summary into `payload.metrics` and `payload.details.observability.compute`.
- `perf-lab.e2e-spec.ts` — `installComputeSpanSink()` in the outer `beforeAll`,
  alongside `installPerfTraceCollector()`. Once per process; the per-engine
  `resetAxiosInterceptors()` must not touch it.
- `package.json` — add `check:compute-span-model` to the `check` chain.

`measureAsyncWithCompute` is **not** part of Phase 1. It would ship unused —
nothing calls it until the per-step conversion in Phase 5, which is where it
belongs.

## Metric surface

Emitted metrics (all `roundMetric`-rounded, `ms` unless noted):

| Metric                       | Meaning                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------- |
| `computeMs`                  | Total computed-execution occupancy.                                           |
| `computeInlineMs`            | Occupancy inside the request (`phase` ∈ `full`, `sync`).                      |
| `computeAsyncMs`             | Occupancy inside outbox tasks (`phase` = `async`).                            |
| `computeTaskMs`              | Outbox task envelope.                                                         |
| `computeTaskOverheadMs`      | `computeTaskMs − computeAsyncMs`. The scheduling tax.                         |
| `computeRunCount`            | Distinct `computed.runId` (count, not ms).                                    |
| `computeTaskCount`           | Distinct `computed.taskId` (count).                                           |
| `computeStepsExecuted`       | Σ `computed.executedStepCount`. Work-volume control.                          |
| `computeEstimatedComplexity` | Max `computed.estimatedComplexity`. Work-volume control.                      |
| `computeSpanCount`           | Matching spans attributed to the window (count).                              |
| `computeSpillInCount`        | Excluded spans (count). Contamination signal.                                 |
| `computeUnsettledSpans`      | Spans started but not ended in window (count).                                |
| `computeSamplesDropped`      | Samples lost to the buffer cap (count). Sums are a lower bound when non-zero. |
| `computeSinkAttached`        | `1` when the sink was live, `0` when it never attached.                       |

These land in Performance Track's `Metrics JSON` for free
(`scripts/performance-track-record-model.mjs:155`) — no Teable schema change is
required to start collecting.

Reporting is a **separate decision and a later phase**. The release-baseline
comparison reads only `Primary Metric Value`
(`scripts/release-baseline-model.mjs:157,237`), so nothing here reaches the
Feishu card until a dedicated column and a second comparison leg are added.
That is deliberate: collect first, establish the run-to-run noise band, then
decide what is worth alerting on. Compute time must **not** become a case's
primary metric — the primary metric answers "how long did the user wait", which
is still the right acceptance gate.

## Rollout

**Phase 1 — collect.** Sink, model, per-case window, metrics into
`Metrics JSON`. No thresholds, no report changes, no case doc changes. Ship
behind `PERF_LAB_COMPUTE_SPANS` (default on; the flag exists to disable it
without a revert if it destabilizes a run).

**Phase 2 — report, without a gate.** Shipped ahead of the noise measurement
below, which reverses the original order. Reporting a ratio carries no
false-alarm cost — a mislabelled row is not a red run — and the report is what
makes Phase 3's data legible in the first place: per-case compute ratios are
easier to read off a rendered summary each run than to reconstruct from
`Metrics JSON` afterwards.

`compute-comparison-model.mjs` pairs this run's `computeMs` against the released
build's and reads the two ratios together, since neither alone separates work
saved from work relocated. Baseline compute rides inside the `Metrics JSON`
already written per row — no new Performance Track column, at 689 bytes per row
against the ~25 KB/row that makes an unprojected read fail.

Two constraints the model enforces and the report states:

- **V2 only.** V1 does not use the V2 computed updater and emits none of these
  spans, so a V1 row would report zero compute for a case that computes plenty.
  That is the instrument's blind spot, not a measurement.
- **Same shape only.** Comparison is refused across an inline/outbox boundary,
  because the same work costs 2.2x through the outbox (above). Shape is derived
  from the counters rather than read from `V2_COMPUTED_UPDATE_MODE`: the flag
  records what was requested, the counters record what ran.

**Phase 3 — measure the noise. Done 2026-08-09, and the expectation was wrong.**
Compute time is not quieter than wall clock. It is noisier.

Restated 2026-08-13, over the 91 full runs between 2026-08-07 and 2026-08-13 —
45,296 rows carrying compute metrics, of which 37 cases per run compute anything
at all. Pairs are consecutive full runs of the same case, restricted to an
unchanged shape and an unchanged `computeStepsExecuted`, so both sides did the
same work cut the same way:

| per-case \|Δ\| between consecutive runs |      mean | median |   p90 | over 20% |
| --------------------------------------- | --------: | -----: | ----: | -------: |
| `computeMs`                             | **16.0%** |   8.6% | 37.2% |      28% |
| wall clock, same cases and runs         |     13.6% |   8.1% | 28.8% |      20% |

n = 2,678 pairs. The first measurement ran the same query over the 931 pairs
that existed on 2026-08-09 and read 18.2% / 12.0%, so the difference is data and
not method. **The two columns have converged — the gap went from 6.2 points to
2.4 — and that changes nothing in Phase 4**, which rests on the last column
rather than on the comparison: 28% of unchanged-work pairs still cross the 1.2x
band. Read as an argument that a compute gate is becoming viable, this table has
been read down the wrong column.

The 97 true repeat pairs in the window — one teable-ee commit measured by two
full runs, three such commits — say the same thing with a wider gap: 20.9%
compute against 12.5% wall.

Why it goes the other way is inference, not measurement: wall clock carries
network round trips and seeding, near-fixed costs that dilute the variable part,
and `computeMs` strips exactly those away and leaves the CPU-bound remainder
that a shared runner contends hardest for.

Small denominators explain the extremes and not the spread, which is a
correction to what this document claimed at three times less data. The two
noisiest cases are still the two smallest —
`lookup/dual-link-computed-first-link-1of4k-get-record`, 237ms median, moves
36.7% run to run — but "every case above ~1s sits in single digits or low teens"
is false on the fuller sample: 18 of the 37 cases sit at or above 1s, and the
noisiest of those, `lookup/customer-update-user-create-order-4k-depth5` at
1597ms, moves 23.1%. Being large is not protection.

These numbers are copied rather than imported, deliberately: a threshold and a
sentence age differently, and making the renderer import the spec is the worse
coupling. The cost is that a re-measurement has to land everywhere, and the
copies are the ones nobody re-reads. The 2026-08-13 restatement found **six**,
where this paragraph previously claimed two — so the list is now written out,
and anything added to it belongs here on the same day:

| copy                                       | carries                                                                          |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `scripts/perf-run-summary-model.mjs`       | `COMPUTE_NOISE_NOTE`, the sentence on the Feishu card, plus the comment above it |
| `scripts/check-perf-run-summary-model.mjs` | an assertion pinning the card's figures, and a wall-clock figure in a comment    |
| `scripts/compute-comparison-model.mjs`     | the header argument for why nothing here gates                                   |
| `docs/operations/teable-ee-e2e.md`         | the operator-facing version of the same caveat                                   |
| `scripts/resolve-release-baseline.mjs`     | the wall-clock figure only, justifying the same-commit skip                      |

Only five of the six had to be found by hand. The assertion in
`check-perf-run-summary-model.mjs` failed on the first `pnpm check` after the
card constant moved, which is what a copy that matters should do — and is why
that one is pinned to the figures rather than to the shape of the sentence. The
card's copy is the one that matters most: the 1.2x band it sorts by sits on this
floor, so a "计算变慢 8" count means nothing without it.

**Phase 4 — do not gate.** Phase 3 yielded its number and the number refuses.
The 1.2x band is a 20% threshold, and 28% of unchanged-work pairs cross it on
their own; a gate there would report nothing happening, most of the time it
spoke. That is already the wall-clock gate's failure — it fires on 42 of 263 V1
cases whose code did not change between runs, and people have learned to skip
it. A second, noisier one teaches the same lesson faster.

So `DEFAULT_COMPUTE_BAND` labels rows on a report and gates nothing, and that is
now a result rather than a placeholder. If compute time ever needs to raise an
alarm, it needs the shape the read path uses — a per-case noise model, each case
judged against its own history — not a constant shared across 37 cases whose
noise spans 6.3% to 36.7%. A fixed band cannot be picked for that spread; there
is no value that is neither deaf on the quiet cases nor screaming on the loud
ones.

What compute time is good for is unchanged, and is not a threshold question:
deciding whether one specific wall-clock movement was work saved or work
relocated. Relocation shows up as 2-3x — `foreign-select-flip-1of40-fanout100-4k`
moved 836.29ms off the request path — which is far clear of an 18% floor. Read
it when a wall-clock number changes and you want to know why. Do not ask it to
watch 37 cases unattended.

**Phase 5 — precise windows.** Convert the ~20 `HYBRID_COMPUTED_CASES`
(`scripts/run-plan.mjs:27`) and the computed-heavy sync cases to
`measureAsyncWithCompute` on their measured region. Update each case's `*.md`.

## Failure modes and guards

The OTel reach is the main risk. It fails silently by design — a missing
processor produces zero spans, which looks identical to a case that did no
computing.

- **Degrade, never fail.** If `_tracerProvider` or
  `_activeSpanProcessor._spanProcessors` is missing or is not an array, log one
  loud warning, set `computeSinkAttached: 0` in the artifact, and skip every
  compute metric. A perf run must never go red because observability moved.
- **Job-level liveness check.** The sink counts _all_ spans it sees, not just
  matching ones. A job that ends having seen zero spans of any name is an
  attachment break, not a quiet suite. Phase 1 logs this as a loud warning
  rather than failing the job: the guard has never run in CI, and a guard whose
  first act is to fail an unrelated perf run is worse than the gap it closes.
  It hardens into a failure once a green run has established the baseline.
- **Bounded memory.** Sample buffer capped (default 20k, override with
  `PERF_LAB_COMPUTE_SPAN_MAX_SAMPLES`) with a `computeSamplesDropped` counter.
  Overflow drops the newest sample so the drop is O(1) and every affected
  window's sums are an explicit lower bound.
- **Never throws into the engine.** `onStart`/`onEnd` run inside the engine's
  span lifecycle, so both bodies are wrapped: a malformed span is skipped, not
  propagated.
- **Kill switch.** `PERF_LAB_COMPUTE_SPANS=false` disables the sink without a
  revert.
- **No engine coupling in the model.** Span names and attribute keys live in one
  exported constant in `compute-span-model.ts`. If teable-ee renames a span, one
  constant changes and the liveness check flags it in the meantime.

## Verification

Add to the `check` chain:

```bash
pnpm check
```

New: `check:compute-span-model` → `node --experimental-strip-types --test
framework/compute-span-model.test.js`. Cases the test must cover:

- Nested `processClaimedTask` + `execute` sums to the `execute` duration only.
- Phase split across `full` / `sync` / `async`, and a missing phase counting as
  inline rather than silently inflating the async leg.
- Spill-in excluded and counted; spans ending outside the window ignored.
- Overhead clamped at zero when a task span outlives its `execute` span.
- Empty window yields zeros, not `NaN` or `-Infinity` (the existing observer's
  `Math.max(...[])` bug class).
- Duplicate `runId` across continuation tasks collapses to one `computeRunCount`
  while still counting each task.
- Steps summed but estimated complexity taken as a max, so continuation stages
  do not multiply one plan's cost.
- Sample construction: unknown span names dropped, `outbox.taskId` read as the
  worker-side task id, a backwards clock clamped to zero, an out-of-contract
  phase rejected.

Smoke, on the first CI run rather than locally — the sink only has anything to
observe inside a real seeded run. Dispatch a targeted run over two hybrid cases
and two sync cases, then read `computeSinkAttached`, `computeAsyncMs`, and
`computeInlineMs` out of each artifact:

- A hybrid case must show `computeAsyncMs > 0`.
- A sync case must show `computeInlineMs > 0` and `computeAsyncMs == 0`. A sync
  case reporting async compute means the phase attribution is wrong.
- `computeSinkAttached == 0` anywhere means the OTel reach missed.

## Explicitly out of scope

- **No teable-ee changes.** Per `AGENTS.md`, perf-lab work does not edit the
  engine checkout. Everything here reads spans the engine already emits.
- **No outbox-table polling.** `computed_update_outbox` has no duration column
  and `markDone` deletes the row (`ComputedUpdateOutbox.ts:1650,1695`), so
  post-hoc queries return nothing. The existing `ComputedOutboxObserver` stays
  as is, for backlog shape only.
- **No `computed_*_activity` reads.** `last_duration_ms` is overwritten per
  field and `recent_completions` is a 20-entry ring
  (`TableComputeMeta.ts:50`) written once per _(task × field)_ with the task's
  duration repeated (`ComputedActivity.ts:204-226`) — summing it overcounts by
  the field fan-out factor.
- **No Jaeger queries per case.** In-process capture makes them unnecessary and
  the fetch budget makes them expensive.
- **No CI gate.** Report-only, consistent with the release-baseline comparison's
  standing decision.
