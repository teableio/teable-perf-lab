---
owner: backend
tags:
  - smoke
  - auth
  - v1-v2
enabled: true
---

# smoke/auth-user

## Goal

Verify that the seeded e2e user can call the authenticated user profile endpoint
and measure basic request latency.

## Seed Phase

- Uses the standard Teable e2e seed user.
- User id: `usrTestUserId`
- Email: `test@e2e.com`
- No extra tables or records are created.
- Seed hash inputs are limited to the e2e seed baseline and this case id. There
  is no case-specific fixture artifact.

## Execute Phase

1. Start the `teable-ee` e2e Nest application.
2. Sign in through the existing e2e `initApp()` flow.
3. Warm up `GET /api/auth/user/me`.
4. Run the configured number of measured samples.
5. Verify every response returns the seeded user.

## Primary Metric

- `p95Ms`: historical p95 threshold key for measured
  `GET /api/auth/user/me` calls. With the default 10 samples, the current
  nearest-rank percentile math makes this gate effectively the slowest request
  (max).

Only the configured measured samples contribute to `p95Ms`. App startup,
session initialization, the warmup request, and seeded-user validation setup are
outside the sample set; each measured sample still verifies the HTTP 200
response and seeded user id/email.

The result also emits `minMs`, `p50Ms`, and `maxMs`; `maxMs` is expected to
match `p95Ms` while the case keeps 10 samples.

## Notes

This case is a smoke check for the perf-lab harness itself. If it fails, inspect
authentication/session setup before investigating computed-field performance.
