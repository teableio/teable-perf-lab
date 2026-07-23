# 01 — Establish full-run feedback-loop regression gates

**What to build:** 提供一个可重复的 full-run 评估入口：给定计划与历史/合成 telemetry，输出 active wall、各阶段 critical shard、跨 shard 重复 seed、trace 缺失与浪费，并按 Cold/Warm/Trace SLO 给出明确通过或失败。它把本次 73 分钟问题变成紧反馈回路，供后续 ticket 逐项转绿。

**Blocked by:** None — can start immediately.

**Status:** completed

- [x] 问题运行 fixture 被判为失败，并报告 73m06s wall、seed/execute 关键阶段、重复 seed 与 2,300 个 missing traces。
- [x] 已接受的 cold 与 warm fixture 分别按 45 分钟和 25 分钟目标通过。
- [x] 输出把 runner queue 与 active workflow wall 分开，不把排队时间归因给引擎。
- [x] CLI/assert 模式对不达标输入返回非零，对健康输入返回零；模型测试可以稳定复现两种路径。
- [x] 缺少 plan、阶段、coverage、seed 或 trace 证据的输入按结构错误退出，不会误判 PASS。
- [x] 新观察到的跨 shard 重复 seed 是阻断失败，不只是诊断信息。
- [x] 评估结果包含足够的 affinity、seed hash、shard 和 engine 信息，可直接定位下一项修复。
- [x] 快速回归检查纳入仓库完整检查且保持主分支测试为绿。
