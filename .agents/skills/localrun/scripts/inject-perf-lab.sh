#!/usr/bin/env bash
set -euo pipefail

PERF_LAB="${PERF_LAB:-/Users/leo/tea/tea-project/teable-perf-lab}"
TEABLE_EE_SANDBOX="${TEABLE_EE_SANDBOX:-/Users/leo/tea/tea-project/teable-ee-perf-local}"

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
