# BYODB stress evidence migration

This guide repairs historical stress evidence in the non-production evidence
base so that scenarios, keys, verdicts, and cleanup receipts match
[the evidence contract](byodb-stress-evidence-contract.md). Run it only when no
writer is active for the affected `Run_ID`.

## Preconditions

1. Confirm the run is finished, its run row exists, bundles are archived in
   durable storage, and no provisioning or cleanup process is active.
2. Record row counts, dangling links, lifecycle-status distribution, and
   duplicate/missing evidence keys.
3. Export all affected tables plus field/view definitions to an external JSON
   backup. Record URI and SHA-256.
4. Record the operator and maintain a change log of record IDs and before/after
   values. Use `[待核对]` for unknown IDs; never invent one.

Run the read-only key audit:

```bash
node scripts/stress/check-evidence-keys.mjs --json > <backup-dir>/pre-migration-keys.json
```

A non-zero exit is expected while historical key drift remains.

## Additive schema

Create missing fields before changing rows, with a description recording units
and representation. Required additions include:

- run: `PG_Instance_Count`, `DB_Per_Instance`, `Parent_Run_ID`,
  `Step_Target_RPS`, `Row_Kind`, canonical `Scenario_ID`, `Scenario_Label`,
  `Capacity_Bound`, `Estimated_At`, `Cost_Coverage`, `Base_Currency`, frozen
  environment/pool/RTT columns, evidence-row counters, `Evidence_Complete`,
  `Gate_Violations`, `Key_Version`, `Last_Run_At`;
- result: `Max_Passing_RPS`, `Capacity_Bound`, `Step_Target_RPS`,
  `Scenario_Label`, `SLO_P95_MS`, `Key_Version`;
- every evidence table: `Key_Version`;
- cost: `Base_Currency`, `FX_Rate`, `FX_AsOf`;
- resource: `Deletion_Evidence_Code`, `Deleted_At_Source`;
- correctness: `Verifier`, `Sample_Ref`, `Permission_Check`;
- registry: instance/database budget, per-operation SLOs, and last-run rollups.

## Canonical identities

1. Raise the canonical registry row's `Spec_Version` first and write the
   per-operation SLOs and budget fields.
2. Re-link result rows from per-run label rows to the canonical scenario row.
   Count links before and after.
3. Set `Scenario_ID` to the canonical ID and preserve the old label in
   `Scenario_Label`. Do not fabricate `Repeat`.
4. Once label rows have zero links, mark them excluded/inactive with a reason;
   delete only after backup and dangling-link verification.
5. Map lifecycle statuses: pass/capacity-only to passed; fail/aborted to failed;
   inconclusive to failed with `Last_Verdict=inconclusive`; keep blocked only for
   genuinely unrunnable rows.

## Breakpoint rows

- Umbrella: `Row_Kind=summary`, no parent, no step target, no request total or
  latency percentiles. Move lifecycle totals into an explanatory field with
  `{raw, step_total_sum, unallocated}`.
- Step: `Row_Kind=step`, parent link to the umbrella, numeric step target, and
  canonical scenario ID.
- Capacity: keep `Max_Sustainable_RPS=null` when there is no qualifying failing
  successor and repeats. Write `Max_Passing_RPS`, `Capacity_Bound=lower`, and
  the lower-bound wording.
- Split prose per-operation latencies into one row per `Operation_Key`; remove
  them from long text.

## Correctness, resources, and cost

- A check with null `Delta`/`Tolerance` or same-token verification is `partial`.
  Add an independent-token or SQL verifier and a sample reference; add an
  explicit permission-isolation check.
- Each resource needs its own provider/API receipt at deletion time. Query the
  owning provider/API and record the exact not-found response, for example
  `DBInstanceNotFound`, `InvalidGroup.NotFound`, `InvalidInstanceID.NotFound`,
  or the product API's deleted-space response. `Deleted_At` is the receipt time.
  A shared batch timestamp or one generic receipt is invalid. A missing current
  receipt makes `Deletion_Verified` null and cleanup unverified.
- Cost rows keep observed component amounts and null for unavailable prices.
  A partial component sum is not total cost. Write `Cost_Coverage=partial` and
  null run-level `Actual_Run_Cost`. `Estimated_At` must precede run start.
- Regenerate a report only to fill missing metadata. Preserve `Data_Hash` when
  the underlying data is unchanged; add `Generated_At`, `Query_Receipt`, and
  `Source_Tables`.

## Evidence keys

`v2` keys come only from `buildEvidenceKey()` in
`scripts/stress/evidence-gate.mjs`. For each table:

1. Read the run's rows and compute canonical keys; resolve semantic collisions
   before writing.
2. Patch the row's key and `Key_Version=v2`; retain the previous key as an
   explanatory note.
3. Run `node scripts/stress/check-evidence-keys.mjs --table <table_id>` until
   duplicates and missing keys are zero.
4. Leave `legacy-archive` history at `v1-drifted`; never dual-key one row.

## Verdict recalculation

Recalculate verdicts from archived bundles rather than by hand, for example:

```bash
node scripts/stress/record-run.mjs --bundle <archived-bundle>.json \
  --gate report --dry-run --out <backup-dir>/gate-<run>.json
```

Record derived values for every affected run/result row. Human edits may only
be stricter than the deterministic verdict. Do not re-record the whole bundle
after manual evidence repair, because that can overwrite repaired fields.

## Closeout and rollback

Require zero duplicate/missing keys, zero dangling links, no `tested` status,
no lifecycle gaps, and expected row counts. Re-run each report query in
[the report guide](byodb-stress-report-guide.md), then smoke-read a regenerated
report with its receipt and hash.

On any failure, stop and restore the affected rows from the step's backup while
retaining the previous read path; record the failure and scope.
