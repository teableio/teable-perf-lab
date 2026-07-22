# 08 — Pipeline seed and execute per shard if the SLO still misses

**What to build:** 仅当 Cold/Warm 验收证明全局 seed matrix barrier 仍是 cold SLO 的主要阻塞时，把 workflow 改为 shard 级 `seed N -> execute N` pipeline，使已完成 seed 的 shard 可以立即启动对应 V1/V2 execute，report 最后汇总全部必需结果。

**Blocked by:** 07 — Accept cold and warm full-run feedback SLOs. Only execute this ticket when ticket 07 records an SLO miss attributable to the global seed barrier.

**Status:** ready-for-agent

- [ ] 验收记录明确证明 barrier 是剩余关键路径；如果 Cold/Warm SLO 已通过，本 ticket 标记为无需执行。
- [ ] 每个 execute shard 只依赖对应 seed shard，不能下载或运行错误的 seed artifact。
- [ ] V1、V2 sync 和 V2 hybrid 保持原有 case mapping、computed mode 与结果命名。
- [ ] 任一 seed/execute shard 失败时，report 仍能收集已有轻量 artifact 并给出完整失败诊断。
- [ ] workflow graph、artifact dependency 和 cache identity 有静态行为检查。
- [ ] 新结构再次通过 cold/warm full-run artifact 验收，并证明 active wall 的改善来自 overlap 而非 coverage 或 threshold 变化。
