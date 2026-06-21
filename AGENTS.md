# Agent Guide

This repository is the control plane for Teable performance regression cases.

Read `README.md` first for the project overview. Before adding or changing a
case, read the agent playbook in `.agents/` and draft the case spec first; that
folder is the source of truth for the authoring workflow. Do not duplicate it
here. Its entry point is `.agents/README.md`.

## Working Rules

- Keep changes inside this repository unless the user explicitly asks to edit an
  adjacent checkout.
- Do not modify `../teable-ee` when implementing perf-lab cases. The GitHub
  workflow copies this repo's case framework into a checked-out `teable-ee`
  workspace at runtime.
- Case definitions live in `cases/**/*.case.ts`.
- Every case must have a same-name `cases/**/*.md` description.
- Runnable cases must be registered in `registry.ts`.
- Shared execution code belongs in `framework/`.
- Keep case data deterministic so V1/V2 and repeated runs are comparable.

## Verification

Run this before finishing code or documentation changes:

```bash
pnpm check
```

This chains: `format:check`, `check:yaml`, `check:ts`, `check:types`,
`check:trace`, `check:catalog`, `check:run-plan`,
`check:artifact-read-model`, `check:run-summary-model`,
`check:artifact-diff-model`, `check:record-read-model`, `check:cases`,
`check:readme`. `check:catalog` fails loud if the disk case files, the
`registry.ts` imports, and the registered `cases` array disagree — so adding a
case requires all of: the `*.case.ts` plus its same-name `*.md`, the import in
`registry.ts`, and the entry in the `cases` array.

For case registry validation only:

```bash
pnpm check:cases
```

To sync the Teable `Perf Cases` registry locally, use:

```bash
TEABLE_PERF_LAB_TOKEN=<token> pnpm sync:cases
```

GitHub Actions also syncs case metadata to Teable after pushes to `main`.

## CI Entry Points

To run a case through GitHub Actions, see the trigger command and all workflow
inputs in [docs/operations/teable-ee-e2e.md](docs/operations/teable-ee-e2e.md).
That file is the single source of truth for running the workflow. The Teable
case registry stores the same reproduce command and a link to each case
description markdown.
