# ADR 0003: Separate historical detection from causal regression proof

- Status: Accepted
- Date: 2026-09-01

## Context

The nightly workflow has a useful long history and can find unusual points and
persistent shifts. It cannot prove that one code revision caused a slowdown:
V1, V2 sync, and V2 hybrid are separate GitHub Actions matrix jobs, hence
separate hosted VMs. Matching commit and seed identity does not make their
measurements paired.

The previous confirmed detector subtracted `log(v1)` from `log(v2)` at the same
commit and described that as a same-machine paired control. That assumption did
not match the execution topology. The fast detector also grouped history by
case id alone, so workload, metric, sample-policy, or harness changes could be
treated as performance changes.

## Decision

Use four explicit evidence levels:

1. `anomaly_candidate`: one current observation is unusual against compatible
   recent history. It is a triage hint, not a regression verdict.
2. `confirmed_shift`: a multiple-testing-controlled historical V2 change point.
   The historical lane removes only a well-supported global run effect. V1 is a
   separate-runner cohort used for corroboration and movement attribution.
3. `code_regression`: a same-host base/candidate experiment exceeds the
   practical budget and passes its paired confidence and hypothesis gates.
4. `incident`: a persisted finding with introduction, recovery, duration, and
   an explicit evidence level. The existing historical ledger records
   `confirmed_shift`; it does not silently promote that shift to
   `code_regression`.

Every new artifact carries three independent identities:

- a measurement contract id derived from the workload, runner, engine, primary
  metric, sample policy, computed mode, and seed schema;
- an environment class/fingerprint derived from runner, CPU, Node, OS, image,
  and database class;
- execution provenance such as repository SHA, job, shard, experiment, variant,
  pair, and order.

Historical comparisons use exact contract and environment-class matches once
enough compatible history exists. During migration, legacy history is allowed
only as an explicitly labelled fallback. Static case thresholds remain
correctness/guardrail signals; the paired experiment observes timing without
allowing an old max-duration threshold to abort the statistical experiment.

The paired experiment runs base and candidate sequentially on one host, restores
the same seed dump and clears a dedicated cache before every observation,
alternates order, records CPU and database canaries, uses the geometric mean of paired ratios, a seeded paired
bootstrap interval, a one-sided sign-flip test over a 10% practical budget, and
Benjamini-Hochberg correction across cases. Ten complete pairs are required.
Environment drift or incomplete/contract-mismatched pairs are inconclusive,
never passing.

## Operational boundary

The reusable order/statistics model, schema checker, artifact identity validator,
and offline verdict writer are committed. The public repository does not contain
an executor that checks out or runs private product code, inherits CI secrets,
or resets state. That security boundary requires an explicitly authorized,
trusted runner. It must accept only immutable full commit SHAs, require a
protected environment or equivalent trusted approval, avoid untrusted
repository-dispatch payloads, and restore only into dedicated experiment
services. This keeps private-repository credentials from becoming an
arbitrary-ref code-execution surface.

## Consequences

- Nightly output says candidate or confirmed shift; only the paired lane may
  say code regression.
- The confirmed detector revision is persisted with the seen-set. A statistical
  method change re-seeds once instead of re-announcing shifted historical
  boundaries.
- The Performance Track schema gains optional `Measurement JSON`; old rows and
  old schemas continue to work during migration.
- Existing calibration numbers derived from V1/V2 subtraction remain a
  historical record, not acceptance evidence for the new detector. The new
  historical detector must be recalibrated before any causal language is used.
- A schema-changing base/candidate pair is rejected for the initial paired
  lane. Supporting schema migrations requires a separately designed fixture
  transition protocol.
