# Scale-Up Spec: Dependent Mutations

## Scope

Add the final frozen-campaign siblings for self-link duplication, depth-5
computed fanout, linked/plain record delete, and record redo.

## Scale Dimensions

- Duplicate table with self-link: populated self-link cells `500 -> 2,000`
  while records/fields remain `10k/20`.
- Depth-5 computed mutations: per-user fanout `100 -> 500`, derived orders
  `4k -> 20k`, while users and dependency depth remain fixed.
- Plain and linked record delete: selected rows `1k -> 5k`.
- Redo selection delete: replayed rows `1k -> 10k`.

## Fixture Reuse

The four computed-chain mutation variants share the same deterministic
40-user/20,000-order graph shape; mutation type and write endpoint remain
execute-only differences. Customer-flow cases share the compatible depth-5
graph shape. Delete/redo cases reuse the existing record-replay generator at
their largest required row count but retain isolated destructive execution.

## Verification

Preserve baseline timer boundaries and routing assertions. Verify V2 copied
self-links while explicitly recording the legacy V1 field-absence boundary,
the first and full computed-fanout readiness, all deleted rows and link cleanup,
and redo terminal stream state. Run source checks and local V1/V2 execution,
then inspect primary metrics and trace manifests.

## Local Acceptance: Delete and Redo

All three record lifecycle siblings passed local V1/V2 execution and verified
the terminal zero-row state.

| Operation                    | V1 primary ms | V2 primary ms |
| ---------------------------- | ------------: | ------------: |
| delete 5k plain records      |        458.04 |        857.63 |
| delete 5k linked records     |      4,312.20 |        938.44 |
| redo deletion of 10k records |      1,222.26 |        644.93 |

The first 10k V1 redo attempt showed that the runner's fixed 15s restore poll
ignored the existing case verification timeout. `waitForRowsRestored` now uses
the configured timeout and poll interval; the rerun restored all 10,000 setup
rows, then completed and verified the measured redo. The readiness wait remains
outside `redoReplay10kMs`. Local trace references were captured, while snapshot
downloads were unavailable without Jaeger.

## Local Acceptance: Computed and Customer Fanout

All six 20k-order depth-5 siblings passed local V1/V2 execution. Every artifact
matched the expected engine/feature route and fully scanned the 20,000 seeded
orders. Computed-chain mutations verified exactly 500 affected and 19,500
unaffected orders; customer order creation verified the final 20,001-row state.

| Operation                           | V1 primary ms | V2 primary ms |
| ----------------------------------- | ------------: | ------------: |
| customer control update + order     |        423.20 |      1,178.02 |
| customer order only                 |        369.20 |        934.49 |
| foreign select flip                 |        397.76 |        701.12 |
| foreign first-name update           |        383.13 |        487.98 |
| single-record foreign select update |        577.52 |        674.87 |
| single-record foreign text update   |        428.19 |        482.13 |

The compatible families now genuinely share their largest deterministic seed,
not merely V1/V2 caches for each case. The four computed-chain variants use
hash `048fb71184f37062`; only the first V1 run built it and the other seven runs
were cache hits. The two customer flows use hash `384bc1613eed7ccb`; the shared
maximum User schema always includes the non-computed control field, which the
order-only case leaves untouched. Only the first V1 customer run built it and
the other three runs were cache hits. Cleanup restored mutations and removed
created orders before the next sibling. Local trace references were captured;
snapshot downloads remained unavailable without Jaeger.
