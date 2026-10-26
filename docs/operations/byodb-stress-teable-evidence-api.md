# BYODB stress Teable evidence API reference

Use this reference for table discovery and safe evidence requests. The configured
Teable URL must be a non-production evidence environment. Keep `$PAT` outside
the repository and never print it. Re-read live field metadata before writes;
field IDs may evolve while the logical contract remains stable.

## Tables

| Table          | ID                    | Table            | ID                    |
| -------------- | --------------------- | ---------------- | --------------------- |
| 压测运行       | `tblpOfmLQ0oF7VBd0RG` | 压测场景结果     | `tblekRdSzxaSnWrI8Ef` |
| 压测指标窗口   | `tblBOkY7Coe7nEE5XNJ` | 瓶颈与优化       | `tblQ51xVeMHSVoF8bMW` |
| 压测数据集     | `tblBlNbg5SvNXjmIcE9` | 压测场景目录     | `tbltNQJdOam0wabQreT` |
| BYODB 成本估算 | `tbl29K7mcnlRWActQ6O` | 压测资源生命周期 | `tblhbgQi86tNHPSgRLd` |
| 压测正确性检查 | `tblor6okhLRPq3y6fW7` | 压测报告产物     | `tblRsIZoJQG6WSQ33CE` |

The full field semantics and evidence keys are authoritative in
[the evidence contract](byodb-stress-evidence-contract.md).

## Safe reads

```bash
curl -sS -H "Authorization: Bearer $PAT" \
  "$TEABLE_URL/api/table/$TABLE_ID/field"
curl -sS -H "Authorization: Bearer $PAT" \
  "$TEABLE_URL/api/table/$TABLE_ID/record?take=100&skip=0"
```

For a link filter, use the current API's link-field operator and record ID after
checking field metadata. Page results rather than assuming the first page is
complete.

## Writes

`Evidence_Key` is the idempotency key. Query it first; create when absent and
patch the existing record when present. Link values are structured link cells,
not bare IDs. Percent-formatted fields store fractions:

```json
[{ "id": "recTarget", "title": "target" }]
```

```bash
curl -sS -X PATCH \
  -H "Authorization: Bearer $PAT" \
  -H 'content-type: application/json' \
  "$TEABLE_URL/api/table/$TABLE_ID/record/$RECORD_ID" \
  -d '{"fieldId":"'$PERCENT_FIELD_ID'","value":0.8}'
```

Unchecked checkboxes may be null/omitted; use empty-value semantics rather than
assuming false. Unknown numeric evidence is null with collection status, never
zero.

## Views

Views only hide, order, and filter fields; they do not alter evidence semantics
or substitute for a report query receipt. Discover current view IDs rather than
inventing them. Column visibility uses the table/view `column-meta` PUT endpoint
with an array body; filter and sort are separate PUT operations.

## Recorder ownership

Write normalized bundles through `scripts/stress/record-run.mjs` rather than
maintaining a second evidence-key implementation. Validate canonical key
uniqueness with `scripts/stress/check-evidence-keys.mjs`. Raw k6 summaries are
produced as `c0-k6-summary/v2` by `stress-tests/tools/k6-summary.mjs` and
consumed by `scripts/stress/c0-analyze.py`.
