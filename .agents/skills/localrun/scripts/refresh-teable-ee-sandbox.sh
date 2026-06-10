#!/usr/bin/env bash
set -euo pipefail

TEABLE_EE_MAIN="${TEABLE_EE_MAIN:-/Users/leo/tea/tea-project/teable-ee}"
TEABLE_EE_SANDBOX="${TEABLE_EE_SANDBOX:-/Users/leo/tea/tea-project/teable-ee-perf-local}"
TEABLE_EE_REF="${TEABLE_EE_REF:-origin/develop}"

if ! git -C "$TEABLE_EE_MAIN" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Missing teable-ee git checkout: $TEABLE_EE_MAIN" >&2
  exit 1
fi

git -C "$TEABLE_EE_MAIN" fetch origin

if ! git -C "$TEABLE_EE_SANDBOX" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  mkdir -p "$(dirname "$TEABLE_EE_SANDBOX")"
  git -C "$TEABLE_EE_MAIN" worktree add -B perf-local "$TEABLE_EE_SANDBOX" "$TEABLE_EE_REF"
else
  git -C "$TEABLE_EE_SANDBOX" fetch origin
  git -C "$TEABLE_EE_SANDBOX" reset --hard "$TEABLE_EE_REF"
  git -C "$TEABLE_EE_SANDBOX" clean -fd \
    community/apps/nestjs-backend/test/perf-lab \
    enterprise/backend-ee/vitest-perf-lab.config.ts \
    perf-lab-local-artifacts \
    perf-lab-local-artifacts-* || true
fi

git -C "$TEABLE_EE_SANDBOX" status --short --branch
echo "teable-ee perf sandbox ready: $TEABLE_EE_SANDBOX"
