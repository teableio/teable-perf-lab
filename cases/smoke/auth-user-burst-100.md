---
owner: perf-lab
tags: [smoke, auth, scale-up, v1-v2]
enabled: true
---

# smoke/auth-user-burst-100

## Goal

Scale the authenticated user-profile probe from ten to 100 sequential samples.

## Seed Phase

No data seed; validate the configured test user.

## Execute Phase

Issue 100 authenticated `GET /api/auth/user/me` requests and validate every response.

## Primary Metric

- `p95Ms`: p95 endpoint latency across 100 requests, maximum 2,000 ms.
