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

- `p95Ms`: p95 latency of measured `GET /api/auth/user/me` calls.

## Notes

This case is a smoke check for the perf-lab harness itself. If it fails, inspect
authentication/session setup before investigating computed-field performance.
