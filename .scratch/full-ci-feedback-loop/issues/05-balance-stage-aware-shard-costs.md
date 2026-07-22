# 05 — Balance shards with stage-aware costs

**What to build:** 用 cold seed、V1 execute、V2 sync、V2 hybrid 和 trace 五维成本替换旧的单一权重，让 planner 能导入可信 run telemetry、模拟候选 shard 数并选择预计关键路径最短且 cache movement 可控的确定性计划。

**Blocked by:** 01 — Establish full-run feedback-loop regression gates; 02 — Keep every physical seed fixture in one shard.

**Status:** ready-for-agent

- [ ] 每个 affinity bundle 有独立的阶段成本；planner 不再把 seed 与固定 case overhead 相加后用于所有阶段。
- [ ] 最近 100k record-read/search seed 和 execute telemetry 进入校准数据，不再使用明显低估的默认权重。
- [ ] planner 可离线比较 6–12 个 shard，并报告每个候选的阶段最大值、关键 shard、并发成本与 cache movement。
- [ ] 默认选择满足 SLO 的最低并发计划；相同输入始终产生相同 mapping。
- [ ] 合成与历史 fixture 证明 planner 能识别真实 seed straggler 和 execute straggler，而不仅是平均 case 数。
- [ ] 新计划的 modeled critical path 不劣于当前计划，并且不会拆开 affinity 或混合不兼容 V2 mode。
- [ ] plan summary 同时输出 predicted 与后续 observed 阶段耗时，便于下一次校准发现预测偏差。
