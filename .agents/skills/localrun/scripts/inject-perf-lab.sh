#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PERF_LAB="${PERF_LAB:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}"
TEABLE_EE_SANDBOX="${TEABLE_EE_SANDBOX:-$(git -C "$PERF_LAB" config --local --get perfLab.teableEeSandbox || true)}"

if [ -z "$TEABLE_EE_SANDBOX" ]; then
  echo "Missing teable-ee sandbox path." >&2
  echo "Set TEABLE_EE_SANDBOX or run:" >&2
  echo "  git config --local perfLab.teableEeSandbox /path/to/teable-ee-perf-local" >&2
  exit 1
fi

if [ ! -f "$PERF_LAB/perf-lab.e2e-spec.ts" ]; then
  echo "Missing perf-lab repo: $PERF_LAB" >&2
  exit 1
fi

if ! git -C "$TEABLE_EE_SANDBOX" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "Missing teable-ee sandbox: $TEABLE_EE_SANDBOX" >&2
  echo "Run refresh-teable-ee-sandbox.sh first." >&2
  exit 1
fi

rm -rf "$TEABLE_EE_SANDBOX/community/apps/nestjs-backend/test/perf-lab"
mkdir -p "$TEABLE_EE_SANDBOX/community/apps/nestjs-backend/test/perf-lab"

cp -R \
  "$PERF_LAB/cases" \
  "$PERF_LAB/framework" \
  "$PERF_LAB/perf-lab.e2e-spec.ts" \
  "$PERF_LAB/registry.ts" \
  "$TEABLE_EE_SANDBOX/community/apps/nestjs-backend/test/perf-lab/"

cp "$PERF_LAB/vitest-perf-lab.config.ts" \
  "$TEABLE_EE_SANDBOX/enterprise/backend-ee/vitest-perf-lab.config.ts"

echo "Injected perf-lab into: $TEABLE_EE_SANDBOX"
git -C "$TEABLE_EE_SANDBOX" status --short \
  community/apps/nestjs-backend/test/perf-lab \
  enterprise/backend-ee/vitest-perf-lab.config.ts
