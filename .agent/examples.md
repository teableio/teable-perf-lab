# Worked Example

A real case to copy from: `record-delete/delete-1k`. It reuses a runner and a
shared base config — the common path. **Read the real files; they are the source
of truth, not this page:**

- `cases/record-delete/delete-1k.case.ts`
- `cases/record-delete/delete-1k.md`

The `.case.ts` is short because it spreads a shared base config and only
overrides the table name and threshold (shape shown here for orientation only):

```ts
export default definePerfCase({
  id: "record-delete/delete-1k",
  runner: "record-delete",
  config: {
    ...undoRedo10kBaseConfig, // shared 20-field mixed seed shape
    rowCount: 1_000,
    tableNamePrefix: "perf-record-delete-1k",
    verify: {
      ...undoRedo10kBaseConfig.verify,
      sampleRows: [0, 499, 999],
    },
    threshold: { metric: "delete1kMs", maxMs: 90_000 },
  },
});
```

When a runner already exposes a shared base config (like
`undoRedo10kBaseConfig`), reuse it instead of re-declaring fields/generator.

## What To Notice In That Case

Open `delete-1k.md` and see how it applies the rules from this playbook:

- The `Execute Phase` starts the primary timer **after** seed is ready, so the
  metric excludes setup ([checklist.md](checklist.md)).
- It is a stream case: it reads the event stream to the `done` event and verifies
  final state through record reads, not just HTTP 200.
- `record-undo` and `record-redo` reuse the same base config and run delete (and
  undo) as _setup_, then measure the next stream — extending the family through a
  shared runner/config rather than a new runner ([runners.md](runners.md)).
