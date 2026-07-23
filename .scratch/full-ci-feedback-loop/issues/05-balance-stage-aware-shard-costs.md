# 05 — Balance shards with stage-aware costs

**What to build:** 用 cold seed、V1 execute、V2 sync、V2 hybrid 和 trace 五维成本替换旧的单一权重，让 planner 能导入可信 run telemetry、模拟候选 shard 数并选择预计关键路径最短且 cache movement 可控的确定性计划。

**Blocked by:** 01 — Establish full-run feedback-loop regression gates; 02 — Keep every physical seed fixture in one shard.

**Status:** implemented-awaiting-full-ci

- [x] 每个 affinity bundle 有独立的阶段成本；planner 不再把 seed 与固定 case overhead 相加后用于所有阶段。
- [x] 最近 100k record-read/search seed 和 execute telemetry 进入校准数据，不再使用明显低估的默认权重。
- [x] planner 可离线比较 6–12 个 shard，并报告每个候选的阶段最大值、关键 shard、并发成本与 cache movement。
- [x] 默认选择满足 SLO 的最低并发计划；相同输入始终产生相同 mapping。
- [x] 合成与历史 fixture 证明 planner 能识别真实 seed straggler 和 execute straggler，而不仅是平均 case 数。
- [x] 新计划的 modeled critical path 不劣于当前计划，并且不会拆开 affinity 或混合不兼容 V2 mode。
- [x] plan summary 同时输出 predicted 与后续 observed 阶段耗时，便于下一次校准发现预测偏差。

## Calibration correction

- 首轮 cold 验收 `29951887405` 暴露了旧校准缺口：7-shard 计划预测最长 cold seed 为 1,408,253ms，实际为 1,893,000ms，cold active wall 达到 49m39s。
- 对同一 commit 的 cold `29951887405` 与 exact-hit warm `29955363070` 轻量 artifact 重新取数，316 个默认 full-run case 均具有 cold seed、V1、V2 与 bounded trace 成本；execute/trace 使用两轮中较大的 case 观测值。
- 校准 key 与当前默认 full-run case 集合做精确全等检查，避免缺项静默回退默认成本；稳定槽位回归也绑定当前选中的 shard 数。
- 修正后最低满足模型 SLO 的稳定方案为 8 shards，0 bundle moves；预测 cold 43m51.9s、warm 18m23.8s。最终结论仍以 Ticket 07 的新 cold/warm 实跑为准。
