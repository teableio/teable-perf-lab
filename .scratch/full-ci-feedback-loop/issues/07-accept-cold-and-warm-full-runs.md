# 07 — Accept cold and warm full-run feedback SLOs

**What to build:** 在同一 commit 和相同 full-run case 集合上，先安全制造 exact seed cache miss 完成一次 cold run，再立即完成一次 exact-hit warm run；用 artifact 而非 job 颜色验证反馈时间、coverage、routing、seed reuse、trace 对账和报告链路。

**Blocked by:** 04 — Reuse compatible seed dumps across safe plan changes; 05 — Balance shards with stage-aware costs; 06 — Defer trace retrieval to a bounded job tail.

**Status:** accepted

- [x] Cold active workflow wall 不超过 45 分钟，Warm active workflow wall 不超过 25 分钟；runner queue 单独报告。
- [x] Cold run 明确证明 exact miss，Warm run 明确证明同一计划 exact hit，不把 compatible restore 冒充 warm acceptance。
- [x] 所有选中 case/engine 结果完整，pass/skip/fail 与预期一致，routing assertions 不退化。
- [x] 同一物理 seed 不跨 shard 重复构建，artifact 中的 seed identity 与 planner affinity 一致。
- [x] 每个 execute job 的 trace tail 不超过 60 秒，case attribution 不超过 15 秒，全部 refs 可由 saved/failed/skipped 对账。
- [x] Feishu、Performance Track 和 GitHub summary 成功，且不重新触发 100KB/1MB payload 限制。
- [x] 不放宽 case threshold、不减少 measured samples、不删除保留的 scale-up case 来取得通过。
- [x] run ids、阶段耗时、关键 shard、预测误差和 cache/trace 证据回写到 spec 或验收记录，供下一轮校准使用。

## First acceptance attempt

- Commit `5d8294585cbdc052a92718256635be938e73aab8`，teable-ee `0725368fe370202b79bb18271aeeeb8c626213b6`，隔离 namespace `cw-5d82945-20260723-a7c91f2b`。
- Cold run `29951887405`：全部 seed shard 为 cache miss，结果/路由/trace/report 完整，但 active wall 49m39s，未达到 45m；最长 seed 31m33s，最长 V1 17m04s。
- Warm run `29955363070`：全部 seed shard 为 exact hit，active wall 20m14s，达到 25m；结果/路由/trace/report 完整。
- Cold 关键路径同时包含 shard 1 的最长 seed 与最长 V1；即使移除全局 seed barrier，估算仍约 49 分钟，因此不满足 Ticket 08 的实施条件。剩余问题归因于 Ticket 05 的 case-level cold-seed 校准不完整，已据两轮 artifact 重校准后重跑本 ticket。

## Final acceptance

- Implementation commit `b2c1530e85503db8d982d98c2b3047c7284ba73c`，teable-ee
  `25ca3466c9cc6b96fa8e229ab1a8c9dd378b4a8a`，隔离 namespace
  `accept-b2c1530-20260723-01`。
- Cold run `29979412537`：8/8 seed shard 为 exact cache miss；316 cases / 632
  engine results 完整；workflow wall 43m45s；最长 seed 25m42s、V1 16m40s、
  V2 sync 12m25s、V2 hybrid 2m56s、trace tail 28s。
- Warm run `29981325193`：相同 commit、plan 和 namespace；8/8 seed shard 为
  exact hit；316 cases / 632 engine results 完整；workflow wall 18m31s；warm seed
  24s、V1 16m36s、V2 sync 12m20s、V2 hybrid 2m52s、trace tail 28s。
- 两轮 report 均通过 physical affinity、result/routing/trace reconciliation 与
  Teable、Feishu、GitHub delivery gate。guarded calibration 已回写 cold/warm
  provenance，未改动 threshold、sample 或保留的 scale-up coverage。
- planner 保守预测为 45m20.6s；包含 trace 的 artifact observed critical path 为
  43m49.6s。逐 case 历史最大值和 60s trace budget 继续保留，未为预测数字放松保护。
