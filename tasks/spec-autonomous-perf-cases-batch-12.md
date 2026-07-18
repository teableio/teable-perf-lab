# Autonomous Perf Cases — Batch 12

Status: approved by standing user authorization on 2026-07-18. The user is
unavailable for per-case confirmation, so the authoring-playbook exception
applies. Implement the assumptions below, validate every case locally in V1 and
V2, and calibrate the shared threshold from official artifacts if needed.

## Batch Goal

Turn the aggregate field-create signals into a scalar field-type matrix on a
populated table. Existing coverage creates five mixed simple fields or nineteen
mixed fields on 10,000 records. Those cases catch broad regressions but cannot
identify the field family responsible, and they do not expose request-count
scaling for a homogeneous schema.

All ten cases reuse the `field-create` runner and `field-add-lifecycle`. Their
seed is the same deterministic 10,000-row table containing only primary
`Title`. A shared runner-level seed identity must therefore build that table
once and reuse it across the batch. The fields-to-create list and threshold are
execute-only and must not enter the shared seed hash.

The primary metric wraps only the sequential field-create requests. Seed
restore, the pre-operation 10,000-row readiness scan, metadata verification,
the post-operation empty-cell scan, and cleanup remain outside the metric. Each
created field must match its requested type and option subset. The runner must
also scan all 10,000 records after creation and prove every new scalar cell is
empty; successful metadata responses alone are not sufficient.

For observability, the new cases opt into per-field trace step ids. One-field
cases retain the only request; ten-field cases retain requests 1, 5, and 10;
the twenty-field case retains requests 1, 10, and 20. Existing field-create
cases keep their current aggregate trace step.

All cases initially use `createScalarFieldsMs` with `maxMs: 40_000`. This is the
established guardrail of the existing nineteen-field case, whose historical
worst is about 18.7 seconds. Official run 29632011977 measured 1, 10, and
20-field V1 maxima of 1,055.16 ms, 9,239.53 ms, and 17,906.97 ms. The accepted
guardrails are therefore 5,000 ms for one field, 20,000 ms for ten fields, and
40,000 ms for twenty fields.

## Cases

1. `field-create/10k-create-1-single-line-text-field`: one text-field request;
   lower bound for field-create routing and schema mutation.
2. `field-create/10k-create-10-single-line-text-fields`: ten homogeneous text
   fields; fixed-width text baseline.
3. `field-create/10k-create-10-long-text-fields`: isolate long-text column
   creation at the same request count.
4. `field-create/10k-create-10-number-fields`: isolate numeric column creation.
5. `field-create/10k-create-10-date-fields`: isolate UTC date field metadata and
   storage creation.
6. `field-create/10k-create-10-checkbox-fields`: isolate checkbox column
   creation and empty-cell semantics.
7. `field-create/10k-create-10-single-select-fields`: isolate creation of ten
   fields, each with the same three deterministic choices.
8. `field-create/10k-create-10-multiple-select-fields`: isolate creation of ten
   fields, each with the same four deterministic choices.
9. `field-create/10k-create-10-rating-fields`: isolate creation of ten five-star
   rating fields.
10. `field-create/10k-create-20-single-line-text-fields`: homogeneous width
    scaling from ten to twenty sequential field-create requests.

## Shared Contract

- **Runner**: `field-create` through `field-add-lifecycle`.
- **Seed**: one shared 10,000-row Title-only table, generated in batches of
  1,000 with deterministic titles.
- **Execute**: create the configured fields sequentially through the public
  field-create API.
- **Primary metric**: `createScalarFieldsMs`, initial `maxMs: 40_000`.
- **Routing**: every field-create response must match the requested engine.
- **Metadata verification**: exact name, type, option subset, choice order,
  choice color, rating max, and date formatting where configured.
- **Value verification**: full 10,000-row API scan of every created field; all
  created scalar cells must be empty.
- **Trace selection**: first/middle/last request through per-field step ids,
  with three-attempt fallback.
- **Cleanup**: restore the shared fixture to Title-only before the next sibling,
  including when execute runs against an isolated shared database.

## Explicit Rejections

- Do not create ten independent 10,000-row seeds. The table contents are
  identical and field shape is execute-only.
- Do not include formula, lookup, rollup, attachment, user, or link fields.
  Computed backfill and dependency setup are different workloads; formulas
  already have a dedicated five-field case.
- Do not populate the new fields after creation. This batch measures schema
  mutation on a populated table and verifies the product's empty-column state.
- Do not count readiness or verification scans in `createScalarFieldsMs`.
- Do not weaken the post-create check to three samples; every new cell must be
  read and confirmed empty.
