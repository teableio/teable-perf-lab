---
owner: backend-v2
tags:
  - computed
  - outbox
  - bullmq
  - recovery
  - fault-injection
  - v2-only
enabled: true
---

# computed-outbox/bullmq-pause-recovery-20k

## Goal

Prove that a temporary BullMQ pause becomes visible in the Computed Outbox
monitor while a 20,000-record depth-four formula update is waiting, then prove
that resuming the queue drains the durable backlog without failed jobs or dead
letters and makes every computed value correct.

## Seed Phase

- Create one deterministic 20,000-row table in the e2e seed base.
- Store `Title` and numeric `A` source fields.
- Add a four-level formula chain where each level adds one to the preceding
  field, then verify the complete baseline chain.
- Cache the source table, formula fields, and records by the runner seed hash.

## Execute Phase

1. Run only on V2 hybrid; V1 returns an explicit skipped artifact.
2. Verify the BullMQ wake-up queue and scoped database Outbox are initially
   clean, then pause the real queue.
3. Update `A` on all 20,000 records in one external bulk-record request.
4. Prove that the queue reports paused work, the scoped database Outbox retains
   pending work, its oldest-task age grows, and formula values remain stale
   while the source values have committed.
5. Poll read-only Computed Outbox monitor snapshots until the durable pending
   task crosses the monitor's real `2 x monitorIntervalMs` overdue boundary;
   retain the queue, database backlog, degraded status, and
   `overdue_pending` reason evidence.
6. Resume the queue in a `finally` boundary, then poll until all formula values
   are correct and the scoped Outbox is drained.
7. Force a second monitor snapshot and assert that the queue is no longer
   paused and no failed job or dead letter remains.

## Primary Metric

- `computedOutboxRecoveryReadyMs`: queue resume through complete formula
  readiness and scoped Outbox drain.

Also record immediate fault visibility time, monitor visibility time, request
time, paused queue/database evidence, monitor snapshots, and final full-scan
proof. The initial recovery `maxMs` is 180,000 ms and is a failure guardrail,
not a throttle. The monitor visibility wait is intentionally outside the
recovery metric because it validates the production health-classification
boundary rather than worker throughput.

## Notes

This is a reversible V2-only fault-injection case. It must run as an exact case
before joining a default plan. It pauses only the computed wake-up queue; it
does not stop Redis because Redis also serves unrelated cache and session
traffic. Queue resume must execute even when an assertion fails.
