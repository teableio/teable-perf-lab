# Case Trace Fix Agent

## Mission

Fix perf-lab cases that show `Trace 缺失` in the performance monitor.

The dashboard is a reader. It flags Teable run fields. Treat the case, runner,
or trace collection path as the default fix target unless the field mapping is
proven wrong.

## Trace Warning Types

The performance monitor should treat trace warnings with these shapes:

- `Failed_Trace_Count > 0`: trace refs were captured, but Jaeger fetch failed
  and no same-request-shape saved snapshot or bounded fallback covered that
  selected trace.
- `Failed_Trace_Count = 0` and
  `Trace_Ref_Count > Saved_Trace_Count + skippedTraceCount` means trace refs were
  captured, but the manifest does not explain every unsaved raw trace snapshot.
- `Trace_Ref_Count > Saved_Trace_Count` alone is not a defect when the manifest
  records the difference as `skippedTraceCount`. High-repeat cases can keep all
  trace refs while saving representative raw Jaeger snapshots.
- `traceFetchSkippedReason` set and `Failed_Trace_Count = 0`: the Trace service
  was unavailable before Jaeger fetch began, so the collector skipped polling
  instead of wasting time on trace ids that could not have been exported.
- Repeated sampled GET or POST refs with a successful same-request-shape raw
  snapshot may be marked `skipped` when a sibling trace 404s in Jaeger. POST
  equivalence includes request-body structure, including array length and
  heterogeneous item shapes. If no representative trace saves for that request
  shape, the fetch must stay failed so the monitor still alerts.
- `Trace_URL` empty: the run has no primary trace link.

## Files To Inspect First

- The affected case definition: `cases/**/*.case.ts`.
- The affected same-name case description: `cases/**/*.md`.
- The runner for the affected case: `framework/runners/*.runner.ts`.
- Trace framework:
  - `framework/trace-collector.ts`
  - `framework/artifacts.ts`
  - `framework/run-perf-case.ts`
- Artifact field/shape reference (read before unpacking a run):
  [artifact-content.md](artifact-content.md).

## Diagnosis Path

1. Inspect the latest artifact `traces/**/manifest.json` for the affected run.
   The lightweight `teable-ee-e2e-perf-results-v*` artifact already carries these
   manifests; only download the full `teable-ee-e2e-perf-v*` artifact when this
   diagnosis needs the raw snapshot JSON files themselves.
2. For `Failed_Trace_Count > 0`, read `savedTraces[]` entries with
   `status: "missing"` or `status: "error"`.
3. If `traceFetchSkippedReason` is present, treat this as Trace service outage
   evidence first; check `flushError` and the observability service, not the
   case runner.
4. Check `error`, `attempts`, `durationMs`, `stepId`, `traceId`, `sampled`, and
   request `url`.
5. For `Trace_Ref_Count > Saved_Trace_Count`, compare:
   - `traceRefCount`
   - `uniqueTraceCount`
   - `savedTraceCount`
   - `skippedTraceCount`
   - `failedTraceCount`
   - semantic request shapes in `refs[]`
     If `savedTraceCount + failedTraceCount + skippedTraceCount` covers
     `traceRefCount`, this is an intentional representative-snapshot gap, not a
     trace-capture failure. `uniqueTraceCount` explains how many distinct trace
     IDs were eligible for fetch; duplicate captured refs have explicit skipped
     outcomes.
6. If `traceFetchBreakerState` is not `closed`, inspect
   `traceFetchBreakerReason`, `traceFetchRecoveryProbeCount`,
   `traceFetchRecoverySucceeded`, `traceFetchWaitMs`, and
   `traceFetchJobWaitMs`. A `partial-loss`, `hard-outage`, `case-budget`, or
   `job-budget` state is explicit missing-evidence telemetry, not a performance
   pass signal.
7. Decide root cause:
   - Jaeger late availability or short timeout -> tune trace fetch timing.
   - Too many captured refs but snapshot cap too low -> adjust
     `PERF_LAB_TRACE_MAX_SNAPSHOTS` or selection priority.
   - High-repeat case only needs representative raw snapshots -> use
     `PERF_LAB_TRACE_INCLUDE_STEP_PATTERN`, keep all refs, and ensure
     `skippedTraceCount` explains the unsaved refs.
   - One selected representative sampled request ref is unstable in Jaeger -> use
     `PERF_LAB_TRACE_FALLBACK_STEP_PATTERN` when the default same-request-shape
     fallback pool needs narrowing, so another equivalent read ref can save the
     representative raw snapshot while the failed selection is skipped with an
     explicit replacement reason.
   - Unsampled refs -> verify sampling expectation, not case failure.
   - Missing `withPerfTraceStep` around important case op -> wrap operation.
   - Runner generates noisy API refs -> narrow step scope or priority rules.

## Fix Rules

- Prefer deterministic case/runner changes.
- Do not hide real failures by changing dashboard labels or filters. Dashboard
  fixes are appropriate only when the field mapping or warning formula is proven
  wrong.
- Do not reduce trace refs only to make counts pass; keep refs useful for
  debugging the performance operation. If raw snapshots are intentionally
  narrowed to representative refs, record the rest as skipped.
- If using fallback representative refs, keep the fallback scope
  same-request-shape and bounded so real Jaeger outages still show as failed
  trace fetches.
- Keep the 15-second case and 60-second job trace budgets. Do not extend them to
  compensate for upstream trace loss; preserve refs and breaker evidence and
  address the exporter/engine separately.
- Producer contract for `stepId`: a trailing number or `sample-N` means "an
  interchangeable repeat of the same operation" (iteration/batch/sample). Steps
  that do structurally different work MUST be told apart by a name, not a bare
  positional index (e.g. `createFormulaField:${formulaName(i)}`, not
  `createFormulaField:${i}`). A bare index collapses to the same normalized
  shape and lets one saved trace falsely cover another step's 404.
- Keep V1/V2 behavior comparable.
- If changing trace collector defaults, explain blast radius.
- Update the case `.md` when behavior or acceptance changes.

## Verification

Run:

```bash
pnpm check
```

If only registry metadata changed:

```bash
pnpm check:cases
```

When possible, rerun affected cases for both engines and confirm:

- `Failed_Trace_Count = 0`
- Saved, failed, and skipped trace counts together cover `Trace_Ref_Count`.
- Trace links open from the monitor
