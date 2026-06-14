# Case Trace Fix Agent

## Mission

Fix perf-lab cases that show `Trace 缺失` in the performance monitor.

The dashboard is a reader. It flags Teable run fields. Treat the case, runner,
or trace collection path as the default fix target unless the field mapping is
proven wrong.

## Trace Warning Types

The performance monitor currently flags these trace warning shapes:

- `Failed_Trace_Count > 0`: trace refs were captured, but Jaeger fetch failed.
- `Failed_Trace_Count = 0` and `Trace_Ref_Count > Saved_Trace_Count` means trace
  refs were captured, but fewer raw trace JSON files were saved.
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
3. Check `error`, `attempts`, `durationMs`, `stepId`, `traceId`, `sampled`, and
   request `url`.
4. For `Trace_Ref_Count > Saved_Trace_Count`, compare:
   - `traceRefCount`
   - `uniqueTraceCount`
   - `savedTraceCount`
   - `skippedTraceCount`
   - selected refs from `selectTraceRefsToSave`
5. Decide root cause:
   - Jaeger late availability or short timeout -> tune trace fetch timing.
   - Too many captured refs but snapshot cap too low -> adjust
     `PERF_LAB_TRACE_MAX_SNAPSHOTS` or selection priority.
   - Unsampled refs -> verify sampling expectation, not case failure.
   - Missing `withPerfTraceStep` around important case op -> wrap operation.
   - Runner generates noisy API refs -> narrow step scope or priority rules.

## Fix Rules

- Prefer deterministic case/runner changes.
- Do not hide warnings by changing dashboard labels or filters.
- Do not reduce trace refs only to make counts pass; keep refs useful for
  debugging the performance operation.
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
- `Saved_Trace_Count >= Trace_Ref_Count` or documented reason if snapshot cap
  intentionally saves fewer than captured refs
- Trace links open from the monitor
