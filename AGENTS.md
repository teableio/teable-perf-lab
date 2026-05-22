# Agent Guide

This repository is the control plane for Teable performance regression cases.

Read `README.md` first. The source of truth for adding or changing cases is the
`Adding A Case` section in `README.md`; do not duplicate that workflow here.

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

Run one case through GitHub Actions:

```bash
gh workflow run "Teable EE e2e perf" \
  --repo teableio/teable-perf-lab \
  --ref main \
  -f teable_ee_ref=<teable-ee-branch-or-sha> \
  -f case_filter=<group>/<case-name> \
  -f engine_filter=v1,v2
```

The Teable case registry stores the same reproduce command and a link to each
case description markdown.
