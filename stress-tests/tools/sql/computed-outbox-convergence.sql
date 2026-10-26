-- Convergence gate sample for the computed outbox.
--
-- Run against the customer (BYODB) database for the space under test. Tables
-- live in the space schema, so pass --schema or prepend SET search_path
-- yourself. Emits exactly one JSON object; convergence-gate.mjs parses the
-- last JSON line and applies the criteria.
--
-- Columns verified against
-- community/packages/v2/adapter-repository-postgres/src/db/schema.ts:
--   computed_update_outbox(id, status, next_run_at, locked_at, ...)
--   computed_update_outbox_seed(id, task_id, table_id, record_id)
--   computed_update_dead_letter(...)
-- {{staleLeaseSeconds}} is substituted by convergence-gate.mjs (default 120,
-- matching the outbox lease).
SELECT json_build_object(
  'backlog', (
    SELECT count(*) FROM computed_update_outbox WHERE status = 'pending'
  ),
  'due', (
    SELECT count(*) FROM computed_update_outbox
    WHERE status = 'pending' AND next_run_at <= now()
  ),
  'active', (
    SELECT count(*) FROM computed_update_outbox WHERE status = 'processing'
  ),
  'stale', (
    SELECT count(*) FROM computed_update_outbox
    WHERE status = 'processing'
      AND (locked_at IS NULL OR locked_at < now() - interval '{{staleLeaseSeconds}} seconds')
  ),
  'seed_origin', (
    SELECT count(*) FROM computed_update_outbox_seed
  ),
  'dead_letters', (
    SELECT count(*) FROM computed_update_dead_letter
  ),
  'oldest_age_ms', (
    SELECT COALESCE(
      GREATEST(0, floor(extract(epoch FROM now() - min(next_run_at)) * 1000))::bigint,
      0
    )
    FROM computed_update_outbox
    WHERE status = 'pending'
  )
);
