# Case Spec Template

Draft this from the user's (possibly partial) input, fill the gaps yourself, and
show it for confirmation before writing any code. Mark every value you inferred
as an assumption.

```md
## Case Spec: <group>/<case-name>

- **Goal**: what regression this catches, in one sentence.
- **Runner**: <runner kind> (reuse | extend | new — say which, and why)
- **Seed Phase**: tables, fields, row count, generator, relationships. What
  state must exist before measurement.
- **Execute Phase**: ordered steps. The measured operation, then execute-only
  cleanup. Start the primary timer only after seed is ready.
- **Primary Metric**: the single metric compared against the threshold, and the
  proposed `maxMs`.
- **Verification**: the read checks that prove the promised final state. Default
  to sample rows plus full scan; use count scan when the case only promises row
  count / empty-table state.
- **Open Assumptions**: every value you guessed (row count, field shape, metric
  bound, endpoint detail). Flag the ones that would change the implementation.
```

## Filling Rules

- **Goal**: tie it to a real product action. "Catch regressions in clearing all
  cells of a 10k grid", not "test clear".
- **Runner**: decide with [runners.md](runners.md). State reuse / extend / new
  explicitly.
- **Seed vs Execute**: keep them separate. Seed builds deterministic source
  state; execute runs the measured operation. See [seed-execute.md](seed-execute.md).
- **Primary Metric**: must measure the operation + readiness, not seed/setup
  cost, unless the case explicitly measures setup. Setup durations are recorded
  as diagnostic metrics, never folded into the primary one.
- **Verification**: prove the final state through the real read path. Use quick
  sample checks plus a paged full scan for value-producing cases. Count scan is
  enough only when the spec promises row count or empty-table state.
- **Assumptions**: anything the user did not state and you chose. Surface the
  ones that matter (a row count that flips the product onto a different code
  path; whether the metric may include a setup step) so they can correct you.

## After Confirmation

Proceed to write `cases/<group>/<case-name>.case.ts` + `.md`, register in
`registry.ts`, then `pnpm check`. See the flow in
[.agents/README.md](README.md).
