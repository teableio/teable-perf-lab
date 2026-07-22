# 04 — Reuse compatible seed dumps across safe plan changes

**What to build:** 在保持 exact cache correctness 的前提下，让 catalog 或 shard case digest 的小变化可以恢复兼容的历史 dump，并依靠 runner seed identity/readiness gate 复用仍有效的 fixture。计划同时尽量保持 affinity 的历史 shard slot，减少一次小改动造成的全量 cache churn。

**Blocked by:** 02 — Keep every physical seed fixture in one shard.

**Status:** implemented-awaiting-full-ci

- [x] exact key 继续绑定完整 case set，不完整 dump 不会被误判为 exact hit。
- [x] compatible fallback 绑定 schema、seed contract generation 和稳定 shard slot，不跨越不兼容数据库形状。
- [x] fallback restore 后，每个 runner 都执行 seed identity 与 readiness 校验；缺失或过期 fixture 会自愈重建。
- [x] 添加或删除一个无关 case 时，未受影响 affinity 的 shard assignment 在负载允许范围内保持稳定。
- [x] 分片必须移动时，计划 summary 明确报告移动的 affinity 与预计 cache 影响。
- [x] cache miss、exact hit、compatible restore 和 fallback validation failure 四条路径都有行为测试。
- [x] execute job 始终消费与自己 shard 对应且验证通过的 seed artifact。
