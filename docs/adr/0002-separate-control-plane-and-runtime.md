# ADR 0002: Keep the performance control plane separate from the runtime

- Status: Accepted
- Date: 2026-08-03

## Context

Performance cases need reviewable contracts, deterministic fixtures, CI
orchestration, result history, and trace evidence. The application under test
already has the authenticated `teable-ee` e2e runtime, so maintaining a second
application runtime in this repository would duplicate product setup and drift
from real behavior.

The original architecture plan mixed these durable decisions with milestones,
draft workflow YAML, case ideas, and storage questions. Most of that execution
plan has since been implemented or superseded by the current code and operating
documentation.

## Decision

- Keep `teable-perf-lab` as the control plane and source of truth for case
  contracts, deterministic seed/execute behavior, thresholds, reporting, and
  workflow orchestration.
- Use `teable-ee` as the runtime harness. CI checks out the requested revision
  and injects the perf-lab execution bundle; perf-case work does not modify the
  adjacent product checkout.
- Treat seed and execute as separate stages. Seed fixtures may be reused only
  when runner validation proves their identity; measured execution always runs
  against an isolated ready fixture.
- Treat GitHub Actions as the acceptance surface. Local runs provide directional
  validation but do not establish acceptance.
- Keep result history and trace evidence on the repository's current reporting
  surfaces. Their schemas and operating procedure belong in code and
  `docs/operations/`, not in a speculative architecture plan.

## Consequences

- New cases remain small, reviewable units in this repository while exercising
  the real product runtime.
- Runtime-specific setup stays behind the workflow and localrun interfaces.
- The generated catalog, runner inventory, artifact checks, and acceptance gates
  are the current source of truth; the original `docs/plan.md` snapshot is no
  longer maintained.
- Open product or retention decisions should be tracked as issues instead of
  accumulating in a repository-local todo document.
