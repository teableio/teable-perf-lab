# Full CI Feedback Loop Reliability

**Status:** ready-for-agent

## Problem Statement

`case_filter=all` 的分片最初把冷启动全量 CI 降到 44 分钟、缓存命中运行降到
15 分钟左右，但随着 scale-up case 进入默认全量集合，反馈时间再次增长到 70
分钟以上。最新问题运行 `29917985095` 的总耗时为 73m06s，其中 seed 阶段
43m58s、execute 阶段 28m22s，已经明显偏离全量性能回归应有的反馈速度。

当前问题不是单一慢 case，而是三个控制面问题叠加：

1. 分片器只认识手工维护的部分 fixture affinity。新增的 100k record-read 和
   search case 虽然在运行时产生相同的物理 `seedHash`，却被分到不同 shard，
   导致同一昂贵 seed 重复构建。已确认的重复 seed 计算至少为 44m48s 的聚合
   工作量。
2. 当前成本模型把旧的 cold-seed 权重和固定的每 case 10 秒开销压成一个标量，
   无法表达 seed、V1 execute、V2 sync、V2 hybrid 和 trace 五条不同的关键路径。
   在问题运行中，最慢 shard 的模型预测约 10 分钟，实际 seed 达到 42m19s。
3. Trace collector 在上游导出发生部分丢失时，仍会对大量永远不会进入 Jaeger
   的 trace 逐个轮询到超时。问题运行共有 2,300 个 trace 未命中，聚合浪费
   49m47s；全断场景已有快速跳过，但“连接正常、部分 trace 永久缺失”的场景
   没有预算和熔断策略。

此外，全量 shard 的精确 cache key 包含 case 集合摘要。case 集合或分片变化时，
所有精确 key 都可能同时失效；当前 restore fallback 仍绑定原 shard case key，
无法充分复用兼容 dump。execute matrix 还全局依赖整个 seed matrix，因此一个
seed straggler 会阻塞所有 execute job。

用户需要的是稳定、可解释的反馈环：保留已经选定的 scale-up coverage，不通过
删除高价值 case 或放宽性能阈值换时间；在 seed cache 冷、热两种情况下都能按
明确 SLO 返回；当 Jaeger 部分丢 trace 时及时保留告警和计数，但不继续空等几十
分钟。

## Solution

把全量 CI 当成由 seed、engine execute、trace evidence 和 report 组成的反馈环，
用显式 fixture identity、分阶段成本和有预算的 trace evidence policy 管理它。

分片计划在运行前获得与物理 seed 一致的稳定 affinity identity，同一 affinity
在任何全量计划中都只能出现在一个 shard。运行后再用 artifact 中观察到的
`seedHash` 交叉验证静态 identity，发现新的跨 shard 重复时让检查明确失败，而
不是等下一次 70 分钟运行才暴露。成本模型分别预测 cold seed、V1、V2 sync、
V2 hybrid 和 trace，选择能压低最大阶段墙钟时间且尽量保持历史 shard 位置的
计划。cache 保留严格的 exact-hit 正确性，同时允许兼容旧 dump 作为候选输入，
由 runner 的 `seedHash` 与 readiness gate 决定哪些 fixture 真正可复用。

Trace 侧保留全部 trace refs，但 raw Jaeger snapshot 按等价 request shape 选择
有限代表。结构不同的写请求必须有不同 shape；同一操作的高重复 GET/POST 不再
因为 method 是 POST 就全部抓取。collector 同时实施 per-case 和 per-job 时间
预算，并在“服务可连接但选中 trace 持续缺失”时进入 partial-loss 熔断状态，
停止对剩余 trace 做长轮询，记录 skipped/missing/wasted/breaker reason，保留真实
告警。最终把 trace flush、settle 和 fetch 从每个 measured case 的串行尾部移到
job 级收尾阶段，以一次有界批处理生成各 case manifest。

最终用同一 commit 连续跑一次 cold full CI 和一次 warm full CI 验收。目标是：

- Cold active workflow wall time 不超过 45 分钟。
- Warm active workflow wall time 不超过 25 分钟。
- Trace 等待单 case 归因不超过 15 秒，单 execute job 不超过 60 秒。
- 所有选中 case/engine 结果完整，现有 V1/V2 workload、阈值和 trace-loss 可见性
  不退化。

如果以上 P0/P1 改造后仍因全局 seed barrier 无法达到 cold SLO，再启用决策门：
把 workflow 改为 shard 级 `seed N -> execute N` pipeline。该结构调整不是首批
实现的前置条件。

## User Stories

1. 作为 perf-lab 维护者，我希望 cold full CI 在 45 分钟内完成，从而在 seed cache 全失效时仍能在一次正常开发反馈周期内获得结果。
2. 作为 perf-lab 维护者，我希望 warm full CI 在 25 分钟内完成，从而让同一 case 集合的复跑可以快速确认修复是否有效。
3. 作为 case 作者，我希望共享同一物理 seed fixture 的 siblings 永远进入同一个 shard，从而不会为相同数据重复支付构建成本。
4. 作为 case 作者，我希望新增 scale-up sibling 时必须声明或推导 seed affinity，从而不会悄悄破坏已经稳定的分片计划。
5. 作为 reviewer，我希望静态 affinity 与运行时观察到的 `seedHash` 能交叉校验，从而发现配置遗漏或 identity 漂移。
6. 作为 reviewer，我希望 full-run 检查能在本地直接证明没有 case 丢失、重复或跨越不兼容的 V2 mode，从而不必依靠真实 CI 才发现计划错误。
7. 作为 CI 维护者，我希望 seed、V1、V2 sync、V2 hybrid 和 trace 使用独立成本维度，从而不会用 seed 权重错误地预测 execute 关键路径。
8. 作为 CI 维护者，我希望成本模型能导入最近一次可信 artifact 的校准数据，从而让新加入的 50k/100k case 不再沿用明显过低的默认值。
9. 作为 CI 维护者，我希望能离线模拟 6 到 12 个 shard 的计划，从而在反馈时间和 runner 并发成本之间做有证据的选择。
10. 作为 CI 维护者，我希望计划生成保持确定性，从而相同 catalog、权重和配置始终产生相同 mapping 与 cache key。
11. 作为 CI 维护者，我希望无关 case 的新增或删除只移动必要的 affinity bundle，从而避免一次小改动让全部 shard cache 同时变冷。
12. 作为 CI 维护者，我希望 exact cache hit 继续保持严格的 case-set 正确性，从而不会把不完整 dump 误认为完整 seed。
13. 作为 CI 维护者，我希望 exact miss 时能恢复兼容的历史 dump 并让每个 runner 自行验证 fixture，从而复用仍然有效的大型 seed。
14. 作为性能结果使用者，我希望所有 captured trace refs 都保留在 artifact 中，从而 raw snapshot 被采样后仍可看到完整请求数量。
15. 作为性能结果使用者，我希望同一 request shape 只抓有限的代表 snapshot，从而高重复 case 不会因为产生数百个写请求就线性增长 trace 时间和 artifact 体积。
16. 作为性能结果使用者，我希望结构不同的写操作不会被错误合并为同一代表，从而一个成功 trace 不会掩盖另一个真实操作的缺失。
17. 作为性能结果使用者，我希望至少一个同 shape snapshot 成功时，其余未抓取 refs 都有明确的 representative/skipped 原因，从而计数可以完整对账。
18. 作为性能结果使用者，我希望一个 request shape 的所有代表都缺失时继续得到失败或 partial-loss 告警，从而优化不会隐藏上游导出故障。
19. 作为 CI 维护者，我希望 exporter 或 Jaeger 完全不可用时立即跳过 fetch 并记录 outage reason，从而不浪费执行时间。
20. 作为 CI 维护者，我希望 Jaeger 可连接但 trace 持续缺失时触发 partial-loss 熔断，从而剩余 trace 不再逐个等待完整超时。
21. 作为 CI 维护者，我希望熔断器保留一次有界恢复探测，从而短暂延迟恢复后可以继续保存代表 evidence，而不是永久关闭本 job 的 trace。
22. 作为 case 作者，我希望 measured operation 与 readiness 的计时不包含 Jaeger settle/fetch，从而 case primary metric 不受观测后处理影响。
23. 作为报告阅读者，我希望结果明确展示 selected、saved、failed、skipped、missing、wasted time 和 breaker reason，从而可以区分引擎退化与观测链路退化。
24. 作为报告阅读者，我希望 GitHub summary、Feishu 和 Performance Track 继续消费兼容的轻量结果，从而本次优化不会重新引入 payload 超限问题。
25. 作为 reviewer，我希望每个优化 ticket 都带一个先失败后通过的行为测试，从而修复的不是某一个 run id，而是可重复的错误模式。
26. 作为 reviewer，我希望 cold/warm 验收核对所有选中 case/engine 的 result、routing、seed 和 trace invariants，从而 job 变绿不是唯一验收标准。
27. 作为 CI 维护者，我希望 runner queue time 与 active workflow wall time 分开报告，从而外部 runner 排队不会被错误归因到分片算法。
28. 作为 CI 维护者，我希望只有在前述优化仍无法达到 cold SLO 时才引入 shard 级 pipeline，从而结构性复杂度有明确的触发证据。

## Implementation Decisions

- 当前已经批准的 full-run scale replacement policy 保持不变；小尺寸 case 仍可按精确 filter 单独运行，但不重新加入默认全量集合。
- planner-visible seed affinity identity 由拥有 seed contract 的 runner/model 负责。它必须来自与运行时 `seedHash` 相同的 seed-relevant 输入，或使用一个显式且唯一的 authoritative affinity alias；不能继续只靠 case 名称相似性猜测。
- 分片计划把 affinity bundle 作为不可拆分单位。100k numeric record-read 三个 siblings 和 100k search-index 两个 siblings 是首批必须补齐的已知 bundle。
- 计划检查同时验证 catalog 完整性、affinity 唯一性、V2 sync/hybrid 边界和“一个 affinity 只在一个 shard”。CI artifact 分析再验证“一个观察到的 `seedHash` 只在一个 shard”；静态与运行时任一层冲突都必须给出 case、affinity、seed hash 和 shard 列表。
- 分片权重改为阶段向量：cold seed、V1 execute、V2 sync execute、V2 hybrid execute、trace budget。优化目标是压低各阶段最大 shard 负载，而不是把所有成本相加成一个标量。
- planner 支持离线模拟 6–12 个 shard。默认选择满足 SLO 的最低并发方案，并把预计关键 shard、各阶段最大值、bundle 数和 case 数写入 plan summary。
- 历史 assignment 是二级优化目标：只要阶段负载仍在允许范围内，就优先保持 affinity 的 shard slot，减少 catalog 小改动造成的 cache churn；负载 SLO 优先于稳定性。
- seed cache 保留带完整 case-set digest 的 exact key。另提供与 schema、seed contract generation 和稳定 shard slot 兼容的 fallback 候选；fallback dump 永远进入 runner-level `seedHash` 与 readiness 校验，不能绕过 correctness gate。
- Trace manifest 继续保存全部 refs。raw snapshot selection 改为 method 无关的 request-shape budget；shape 由规范化 step、method 和 URL 组成。等价重复写可以共享代表，结构不同的写必须通过语义 step 名分开。
- Trace selection 优先保存关键 measured operation，再在每个 request shape 内保留有限代表。fallback 仍必须同 request shape 且次数有界。
- Collector 明确区分 healthy、hard outage、partial loss 和 recovery probe。hard outage 沿用立即跳过；partial loss 在达到最小样本和缺失阈值后停止长轮询剩余候选，只进行有界恢复探测，并把未尝试项标为带原因的 skipped，而不是伪装成 saved。
- Trace budget 同时在 case attribution 和整个 execute job 两层执行。达到预算时必须完成 manifest 对账，并保留 missing/wasted/breaker 指标；不得通过清空 refs、关闭告警或改变上游 sampling 来达标。
- Trace flush、settle 和 fetch 移到 measured cases 全部完成后的 job-level 收尾阶段。每个 case 仍获得独立 manifest 和 summary，批处理失败不能丢失已经生成的性能结果。
- 报告继续区分 engine performance regression 与 trace infrastructure degradation。Feishu 只发送需要关注的结果、GitHub combined summary 保持在平台限制内，这些已完成的压缩策略不得回退。
- workflow 首轮不改变全局 `needs: seed` 拓扑。Cold/Warm 验收后若仍因 seed straggler barrier 超过 45 分钟，才执行 shard 级 reusable pipeline；report 仍等待全部必需 execute job。
- 不通过放宽 case `maxMs`、减少 measured samples、改变 V1/V2 workload 或删除已保留的 scale-up coverage 来满足 CI SLO。

## Testing Decisions

- 本改造使用两个主要自动化 test seam，而不是为每个 workflow step 新建独立 seam：
  1. full-run plan/evaluation seam：从 catalog、affinity、阶段权重、历史 assignment 和 run telemetry 生成计划及 SLO 结论；
  2. trace evidence/collector seam：用受控 exporter/Jaeger fake 验证 selection、fetch、budget、breaker 和 manifest。
- Plan tests 只断言外部计划行为：所有目标 case 恰好出现一次、同 affinity 不跨 shard、sync/hybrid 不混用、计划确定、无关 catalog 改动的移动量有界、exact/fallback cache identity 安全。
- 首个 red regression fixture 必须覆盖已知 100k 问题：三个 numeric record-read siblings 和两个 search-index siblings 在旧计划中跨 shard，新计划中各自只构建一次。
- Artifact evaluation tests 使用脱敏的历史 run telemetry fixture。问题运行必须被判为 cold/warm SLO 失败，并报告重复 seed 与 trace waste；已接受的 cold/warm 基线必须被正确分类。
- 阶段成本测试验证 planner 使用独立向量，并能识别实际 critical stage；不得只验证 case 数平均或总权重下降。
- Trace policy tests 覆盖：健康 Jaeger、exporter 全断、Jaeger 全断、部分 trace 永久缺失、同 shape 代表成功、同 shape 全部缺失、熔断后的恢复探测、case/job budget 耗尽。
- Trace tests 断言所有 refs 最终都能由 saved、failed 或 skipped 对账；同 shape coverage 不能跨越语义不同的 step；partial loss 必须保留可见告警和 wasted time。
- Deferred trace tests 证明 measured case 完成后不再串行等待 settle/fetch，job-level 批处理仍能把 manifest 正确归属到 case/engine，并在异常退出时给每个 case 留下明确状态。
- Workflow YAML/static plan checks 验证 seed artifact 与 execute shard mapping、cache key 层级和条件 pipeline graph，不通过字符串快照代替语义断言。
- 每个实现 ticket 完成前运行仓库完整检查。涉及 trace 或 run plan 的 ticket还必须单独运行对应的快速检查，保持 tight red-green loop。
- 最终 CI 验收用同一 commit、相同 full-run case 集合连续运行 cold 与 warm 两次。Cold run 必须安全制造 exact miss；Warm run 必须证明 exact hit，不能拿 restore-key seed 误称 warm。
- 最终 artifact 验收包括：case/engine coverage、pass/skip/fail、routing、seed hash/命中路径、各阶段墙钟、trace count reconciliation、missing/wasted/breaker reason、report/notification 成功。
- Local trace 环境只用于行为回归；最终 trace acceptance 以 GitHub Actions 的轻量 artifact 与 raw sample 为准。

## Out of Scope

- 修复 `teable-ee` 或观测基础设施中导致 trace 未导出到 Jaeger 的上游根因；本 spec 只保证 perf-lab 对该故障快速、诚实地降级。
- 调整业务引擎中真实的 V1/V2 性能退化、computed projector deadlock 或单个 case 的 workload/threshold。
- 再次大规模筛除 case。默认全量集合沿用当前已批准的 scale-up replacement policy。
- 更换 GitHub Actions、Jaeger、OpenTelemetry、Performance Track 或 Feishu 服务提供方。
- 为追求 cache hit 绕过 schema、seed hash 或 seed readiness 校验。
- 无条件实施 shard 级 seed-to-execute pipeline。它是 Cold/Warm 验收失败后的决策门票，不是首批工作。
- 重做已经完成的 Feishu 卡片压缩和 GitHub summary 压缩；这里只做不回退验证。

## Further Notes

- 已接受 cold 基线：run `29746682913`，44m16s；最长 cold seed 13m05s，最长 V1 14m04s，最长 V2 sync 11m49s。
- 已接受 warm 基线：run `29751280107`，14m38s；seed shard 全部 exact hit，report 38s。
- 最近一次尚可复跑：run `29912515531`，30m22s，seed exact hit；其最终失败来自当时的 Feishu payload 限制，不是 execute。
- 当前问题基线：run `29917985095`，73m06s；seed 43m58s、execute 28m22s、report 26s。
- 当前问题运行中，三个 100k numeric record-read case 具有相同 seed identity 却分布在三个 shard；两个 100k search-index case 也具有相同 seed identity 却分布在两个 shard。已观察到的重复 seed 聚合工作量至少 44m48s。
- 同一运行共有 2,300 个 trace 未命中 Jaeger，累计轮询浪费 49m47s。典型高重复写 case 捕获 500 个 refs、保存 316 个、缺失 184 个，单 case 空等接近 4 分钟。
- active workflow wall time 应从 workflow 实际开始执行到 report/summary 完成计算；runner queue time 单独展示，不作为引擎或 planner 失败原因。
- 本地 tracker 的实现顺序在 `issues/` 中声明。所有 blockers 完成的 ticket 才进入 `/implement`；每个 ticket 使用新的上下文并以 `/tdd` 和 `/code-review` 收尾。
