# Full CI Feedback Loop Reliability

**Status:** cold/warm acceptance passed; final evidence review and merge pending

**Last updated:** 2026-07-23

## Executive Summary

这项工作的目标不是单纯“多切几个 shard”，而是把 `case_filter=all` 建成一个
稳定、可解释、可校准的性能反馈系统：即使 seed cache 全冷，也要在 45 分钟内
返回完整结果；同一计划 exact-hit 复跑要在 25 分钟内完成；Jaeger 部分丢 trace
时，必须保留真实告警，但不能再空等近 50 分钟。

最终同 commit 验收已经通过。Cold run `29979412537` 使用隔离 namespace，8/8 seed
shard 均为 `cache-miss`，总 wall clock 为 43m45s；紧接着的 warm run
`29981325193` 复用相同 perf-lab SHA、teable-ee SHA、plan 和 namespace，8/8 seed
shard 均为 `exact-hit`，总 wall clock 为 18m31s。两轮都满足 45m/25m SLO。

根因与修复也得到两轮实测闭环：10 组、64 个共享物理 seed case 现在由
authoritative `seedAffinity` 固定在同一 shard，不再重复构建；最慢 cold seed 从
诊断 run 的 34m49s 降到 25m42s。trace 抓取改为有预算的 job tail 后，两轮最慢
trace stage 都约 28s，没有再出现 2,300 个 missing trace 导致的 49m47s 空等。

首个修复候选 cold run `29977404790` 暴露了一个真实验收 bug：共享
`record-replay/10k` cleanup 把可选的 polling 配置以 `undefined` 传入，导致 V1/V2
shard 4 失败。该问题先以回归测试复现，再统一解析为 15s/250ms 默认；修复后的
V1/V2 shard 4 在最终 cold/warm 中全部成功。该失败 run 同时证明最终 gate 会在
case 失败时 fail closed，而 Teable、Feishu、GitHub Summary 三路仍独立成功。

最终 report job 另有 fail-closed execute artifact gate：resolve/seed/execute
job 必须成功；计划中的每个 case/engine 必须恰好有一个 pass 或预期 skip payload；
artifact 内所有 routing assertions 必须为真；trace refs 与
saved/failed/skipped 必须完整对账并遵守 15s/60s budget。Teable、Feishu、GitHub
summary 三路采用独立 step outcome，只有三路均成功（同时由各自 builder/webhook
执行 100KB/1MB/per-write 尺寸限制）full run 才能通过。
Skip engine 和无 routing contract 的 measured path 必须在 case 上显式声明；默认
仍是禁止 skip 且必须存在 routing evidence。

## Success Definition

本 spec 完成必须同时满足以下条件，任一项失败都不算完成：

| 维度          | 必须满足的结果                                                                                      |
| ------------- | --------------------------------------------------------------------------------------------------- |
| Cold feedback | 同一 commit、隔离 namespace、全部 seed shard 为 `cache-miss`，active workflow wall ≤ 45m            |
| Warm feedback | 紧接 cold、同 commit/plan/namespace，全部 seed shard 为精确 `exact-hit`，active workflow wall ≤ 25m |
| Coverage      | 默认 full-run case 集合完整；每个预期 case/engine 恰好一个结果；无意外 missing/duplicate            |
| Correctness   | 预期 pass/skip/fail、routing assertions、readiness/final-state verification 全部保持原语义          |
| Seed reuse    | 一个物理 `seedHash` 只能属于一个 authoritative affinity，且只能在一个 shard 构建                    |
| Trace cost    | 单 case 归因 ≤ 15s；单 execute job tail ≤ 60s；refs 可由 saved/failed/skipped 完整对账              |
| Reporting     | Performance Track、Feishu、GitHub combined summary 全部成功；不触发 100KB/1MB 限制                  |
| Integrity     | partial rerun 不得混合不同 perf-lab/teable-ee revision、不同 plan identity 或无 provenance 的证据   |
| Guardrails    | 不减少 samples、不放宽 case threshold、不删除已批准的 scale-up coverage 来换取通过                  |

## Evidence Timeline

| Run           | Cache / purpose                      | Result                               | Key evidence                                                                                                    |
| ------------- | ------------------------------------ | ------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `29746682913` | 旧 catalog cold baseline             | accepted at 44m16s                   | 256 cases / 512 results；7 shards；最长 seed 13m05s、V1 14m04s、V2 sync 11m49s                                  |
| `29751280107` | 旧 catalog warm baseline             | accepted at 14m38s                   | 全部 exact hit；report 从 16m47s 降至 38s                                                                       |
| `29917985095` | scale-up 后的问题基线                | failed at 73m06s                     | seed 43m58s、execute 28m22s；2,300 missing traces；轮询浪费 49m47s；已知重复 seed 聚合 44m48s                   |
| `29951887405` | 首轮 controlled cold acceptance      | workflow success, SLO fail at 49m39s | 全部 cache miss；最长 seed 31m33s、V1 17m04s；结果、路由、trace、report 完整                                    |
| `29955363070` | 与上一轮同 commit 的 controlled warm | accepted at 20m14s                   | 全部 exact hit；证明 warm 路径已经达到 25m 目标                                                                 |
| `29957965247` | 8-shard recalibrated cold diagnosis  | workflow success, cold SLO fail      | 最长 seed 34m49s、V1 17m02s、V2 sync 10m52s、hybrid 2m42s、trace 34.5s；发现 10 个跨 shard 物理 affinity family |
| `29977404790` | 最终方案首个 cold 候选               | failed at 42m17s                     | wall SLO 已达；V1/V2 shard 4 暴露 optional polling 默认值 bug；hybrid shard 4 一次 computed deadlock/retry 抖动 |
| `29979412537` | 修复后的 controlled cold             | accepted at 43m45s                   | 8/8 cache miss；316 cases / 632 results；最长 seed 25m42s、V1 16m40s、V2 sync 12m25s、hybrid 2m56s、trace 28s   |
| `29981325193` | 同 commit/plan/namespace warm        | accepted at 18m31s                   | 8/8 exact hit；316 cases / 632 results；warm seed 24s、V1 16m36s、V2 sync 12m20s、hybrid 2m52s、trace 28s       |

`29957965247` 的 current-run stage observation 同时证明了成本模型剩余偏差：

| Stage      | Predicted critical | Observed critical |  Drift |
| ---------- | -----------------: | ----------------: | -----: |
| Cold seed  |             25m58s |            34m49s | +8m51s |
| V1         |             15m58s |            17m02s | +1m04s |
| V2 sync    |             11m12s |            10m52s |   -20s |
| V2 hybrid  |              2m37s |             2m42s |    +5s |
| Trace tail |                56s |             34.5s |   -22s |

这说明当前剩余 cold 问题集中在 seed identity/packing，而不是 V2 execute、trace tail
或 report。最新 calibration 在取得无重复的 clean cold run 前只能作为保守 envelope，
不能被视为最终可信基线。

## Final Acceptance Result

最终 pair 固定了以下 identity：

- perf-lab SHA：`b2c1530e85503db8d982d98c2b3047c7284ba73c`；
- teable-ee SHA：`25ca3466c9cc6b96fa8e229ab1a8c9dd378b4a8a`；
- seed cache namespace：`accept-b2c1530-20260723-01`；
- cold run：`29979412537`；
- warm run：`29981325193`。

离线 guarded calibration 对 cold artifact 的结论为：316 个 case、8 个 shard、
8/8 `cache-miss`、case coverage 完整、无 missing/unexpected/duplicate。Warm pairing
对相同 identity 的结论为 8/8 `exact-hit`，并拒绝 compatible-candidate 代替 warm。
两轮 report job 均通过 physical seed affinity、完整 result/routing/trace reconciliation
和 Teable/Feishu/GitHub 三路 delivery gate。case `maxMs`、samples、V1/V2 workload 和
已批准的 scale-up coverage 均未放宽或删除。

刷新后的 planner 保守 envelope 为 45m20.6s，比真实 workflow wall 43m45s 高
1m35.6s。按 artifact stage observation 重建的 critical path（cold seed + 最慢
execute + trace tail + report）为 43m49.6s，保守 envelope 比它高 1m31.1s。这不是
新的 wall-time 失败：case calibration 会保留不同历史 run 的逐 case最大值，并额外
保留完整 60s trace job budget，不能为了让预测数字变绿而压低这些保护。计划契约
因此同时验证含 trace 的可信 observed critical path ≤ 45m、保守预测与 observed
的差值不超过一个 execute setup envelope，并在没有预测候选严格达标时选择成本
最低且已有 acceptance 证据的稳定计划。

因此 Ticket 08 的 shard 级 `seed N -> execute N` pipeline 决策门不触发，状态为
`not needed`。现有全局 seed barrier 已在目标内，不为理论并行度继续扩大 workflow
拓扑。

## Newly Observed Physical Seed Families

`29957965247` 的 seed artifact 识别出以下 10 个共享 family。它们共覆盖 64 个默认
full-run case；每组必须是一个不可拆分 bundle，并且 execute-mutated fixture 必须在
同一进程的 sibling 之间恢复到 seed-ready 状态。

| Authoritative affinity               | Case 数 | Required behavior                                                                |
| ------------------------------------ | ------: | -------------------------------------------------------------------------------- |
| `field-create/scalar-title-only-50k` |      10 | 同一 50k title-only table seed 只构建一次                                        |
| `record-create/mixed-5k-20fields`    |       9 | 共用空目标 fixture；每个 sibling 后删除新增 records 并重新验证                   |
| `record-update/mixed-5k-20fields`    |       9 | 共用 mixed fixture；每个 sibling 后恢复 seed values                              |
| `field-duplicate/scalar-matrix-50k`  |       8 | 共用 50k scalar source fixture；只删除 execute 创建字段                          |
| `computed-chain/4k-depth5`           |       8 | 共用 4k depth-5 chain；恢复公式/foreign seed state                               |
| `record-read/50k-50fields`           |       7 | 只读 family；同一 50k×50 fixture 只构建一次                                      |
| `customer-upsert/4k-depth5`          |       5 | 共用 4k customer/order graph；mutation 后恢复                                    |
| `computed-chain/20k-depth5`          |       4 | 共用 20k depth-5 chain；mutation 后恢复                                          |
| `record-replay/10k`                  |       2 | delete-stream 与 restore 共用 10k table；delete sibling 后必须恢复 trash records |
| `customer-upsert/20k-depth5`         |       2 | 共用 20k customer/order graph；mutation 后恢复                                   |

`seedAffinity` 不是“这些 case 看起来相似”的标签。它必须和 runner 生成的物理
`seedHash` identity 对齐；case 声明、planner bundle、artifact identity、shard 和
cleanup lifecycle 必须形成闭环。只把 case 放进同一 shard、但让前一个 sibling
破坏 fixture 后由下一个 sibling 自愈重建，不算 reuse 成功。

## Current Implementation State

本节记录 2026-07-23 的实现快照，后续验收结果应覆盖而不是静默改写这些来源：

- 工作分支：`codex/feishu-summary-compact`。
- 最终验收实现 commit：`b2c1530e85503db8d982d98c2b3047c7284ba73c`。
- 首轮 cold/warm commit：`5d8294585cbdc052a92718256635be938e73aab8`。
- 最终验收使用的 teable-ee commit：
  `25ca3466c9cc6b96fa8e229ab1a8c9dd378b4a8a`。
- guarded cold/warm calibration 和 stable historical slots 已从最终 pair 刷新，尚待
  最终检查、双审和 evidence commit。

已经实现并进入最终 branch diff 的能力：

1. full-run feedback regression gate：离线复现 73m06s、重复 seed、trace waste 和
   cold/warm SLO；证据不完整时 fail closed。
2. affinity-aware planning：共享 physical fixture 作为不可拆分 bundle；catalog、
   affinity、V2 mode、case coverage 和 stable slot 有静态检查。
3. trace partial-loss policy：request-shape representative、case 15s/job 60s budget、
   partial-loss breaker、bounded recovery probe 和完整 count reconciliation。
4. compatible seed dump reuse：exact key 保持完整 case-set correctness；restore-key
   候选必须重新进入 runner `seedHash`/readiness validation。
5. stage-aware 6–12 shard simulation：分别建模 cold seed、V1、V2 sync、V2 hybrid、
   trace；默认选择满足 SLO 的最低并发方案，并限制 cache movement。
6. deferred trace retrieval：所有 measured result 先落盘，再由 job tail 一次 flush /
   settle / fetch / rewrite；trace 网络等待不进入 primary metric。
7. controlled cold/warm acceptance inputs：隔离 cache namespace、预期 perf-lab SHA、
   plan/status identity 和 current-run observation artifact。
8. calibration guard：只有完整 cold run、同一 artifact attempt、完整结果/seed payload、
   一致 commit SHAs、无 affinity drift/duplicate 时才允许刷新校准。
9. report-size guard：Feishu 不发送 V2 更快项，GitHub summary 使用 compact 输出，避免
   再触发 Feishu 100KB 和 GitHub 1MB 上限。

以上能力已经由最终 cold/warm pair 验收；当前 worktree 只包含 guarded calibration
和本 spec 的证据回填，仍需最终完整检查与双审后提交。

实现 ticket 的当前状态：

| Ticket | Deliverable                           | Status                                        |
| ------ | ------------------------------------- | --------------------------------------------- |
| 01     | full-run feedback regression gate     | implemented                                   |
| 02     | physical seed affinity bundling       | accepted                                      |
| 03     | bounded partial-loss trace policy     | accepted                                      |
| 04     | compatible seed dump reuse            | accepted                                      |
| 05     | stage-aware cost planning/calibration | accepted; final pair calibration refreshed    |
| 06     | deferred job-tail trace retrieval     | accepted                                      |
| 07     | controlled cold/warm acceptance       | accepted: cold 29979412537 / warm 29981325193 |
| 08     | per-shard seed→execute pipeline       | not needed; decision gate did not fire        |

## Remaining Review Blockers

开始最终 CI 前必须关闭以下 blocker，并为每条加入先失败后通过的 regression test：

### B1. Partial rerun stage completeness

“Re-run failed jobs” 可能让成功 sibling 留在 attempt 1，失败 shard 出现在 attempt 2。
stage observation 必须读取同一 workflow 的全部 attempts，按逻辑 job 名选择最新
attempt，并用当前 seed/execute plan 枚举完整预期 job 集合。缺任何 planned job、
时间戳或 active stage 都必须标记 `partial`，不能刷新 calibration。

当前状态：已实现并通过 focused/full checks、双审和最终 CI report gate。

### B2. Immutable source revision across attempts

只验证 seed status 的 SHA 彼此相同仍不够。`teable_ee_ref=develop` 是可移动引用；
partial rerun 只重跑一个 execute shard 时，如果重新 checkout 最新 develop，report
可能把 attempt 1 和 attempt 2 的不同 teable-ee commit 结果拼成“完整”632 个结果。

要求：在 workflow 输入解析阶段一次性把 `teable_ee_ref` 解析并 pin 为 immutable
commit SHA，后续所有 seed/execute jobs 和 rerun 都使用该 SHA。seed status 仍必须
校验所有 shard 的 `perfLabSha`/`teableEeSha` 唯一且与当前 workflow identity 一致；
任何跨 revision 证据都 fail closed。

当前状态：已完成 workflow-level immutable SHA pinning 与跨 shard/attempt
revision gate；最终 pair 使用相同的固定 perf-lab/teable-ee SHA。

### B3. Shared mutable `record-replay/10k` lifecycle

`record-delete/delete-stream-10k` 和 `record-restore/restore-10k` 现在共享一个 affinity。
delete-stream 在 isolated execute DB 中不能继续无条件跳过 cleanup：同一 job 内后续
restore sibling 会看到空表，触发删除并重建 10k fixture，抵消共享 seed 的收益，
也改变 sibling 的独立 workload 前提。

要求：delete 完成后定位对应 table trash、恢复全部 deleted records、执行与 seed
readiness 同等级的 row/sample verification；恢复失败则删除 fixture 并明确失败，
不能留下 dirty table。非共享 isolated case 仍可依赖整库丢弃跳过 cleanup。

当前状态：已实现。首个 cold 候选进一步发现 optional polling 默认值 bug；TDD 修复后
V1/V2 shard 4 在最终 cold/warm 中均成功。

### B4. Mixed exact-hit/cache-miss provenance after partial rerun

artifact selector 目前为每个 seed shard 只取最新 artifact。若 attempt 1 完成 build
并保存 cache、但在 upload/summary 后段失败，attempt 2 会变成 exact hit 且不生成
seed payload；其他未重跑 shard 仍来自 attempt 1 的 cache-miss payload。只保留最新
artifact 会丢掉该 shard 真正构建 fixture 的 `seedHash` provenance。

要求：latest exact-hit status 必须能关联同一 logical shard、同一 plan identity、同一
perf-lab/teable-ee SHA 的最近 non-warm payload artifact；report 对 latest status 做
cache 分类，对关联 payload 做 physical affinity 验证。找不到严格匹配的 provenance
时 fail closed，并明确要求 full rerun；不得把 mixed evidence 静默当 warm 或 cold。

当前状态：已实现并由 report selector/provenance gate 覆盖；最终 pair 不需要跨
attempt 补证，但相关 mixed-evidence 回归测试已通过。

### B5. Cold/warm calibration pairing

cold calibration refresh 不能沿用旧文件里来自其他 commit/plan 的
`pairedWarmRunId`。cold source 更新后应先清空 warm pairing；只有单独验证过同一
perf-lab SHA、teable-ee SHA、plan identity、namespace、完整 exact-hit status 和结果
coverage 的 warm run，才能写入 paired warm provenance。

当前状态：已完成。Cold `29979412537` 刷新时清除了旧 pairing，随后只有通过全部
identity、coverage 和 exact-hit gate 的 warm `29981325193` 被写入 paired provenance。

## Final Acceptance Protocol

最终验收按以下顺序执行，不能跳步：

1. 关闭 B1–B5；运行相关 focused checks。
2. 运行完整 `pnpm check`。
3. 对最终 diff 并行执行 Standards review 与 Spec review；任一 finding 回到 TDD，
   修复后重新执行两轴 review，直到双方均为 `No findings`。
4. 提交并推送一个固定 implementation commit；解析并记录固定 teable-ee commit。
5. 生成一次新的、唯一的 isolated seed-cache namespace。
6. 触发 `case_filter=all` cold run，固定 perf-lab SHA、teable-ee SHA、`v1,v2` 和默认
   computed split。不得在运行中修改 branch。
7. cold artifact 验证通过后，不改 commit、不改 plan、不改 namespace，立即触发 warm
   run；如果 cold 未通过，不允许用其 cache 结果声明 warm acceptance。
8. 下载轻量 execute artifacts、seed status/payload artifacts、stage observation、
   seed-affinity observation 和必要 raw trace samples，运行离线 feedback gate。
9. 核对 Success Definition 全部维度。job 绿色但 artifact coverage、routing、SHA、
   affinity、trace reconciliation 或 report 任一失败，整轮验收失败。
10. 两轮通过后，用 cold evidence guarded refresh case/stage calibration，再用 warm
    evidence写入 paired provenance；更新本 spec 与 Ticket 07 的 run ids/timing/drift。
11. 再跑完整检查与最终 review，提交 evidence/calibration，推送并合并。

## Decision Gate: Ticket 08

只有在完成 affinity/cleanup/provenance 修复后的新 cold run 仍超过 45 分钟，并且
artifact 明确证明“全局 seed matrix barrier”是剩余 critical path 时，才实施
`seed N -> execute N` shard pipeline。触发条件必须同时满足：

- 没有跨 shard duplicate seed；
- cold calibration 对关键 shard 的误差已经收敛；
- trace/report 不在 critical path；
- 用真实 job 时间模拟 shard pipeline 后可把 active wall 拉回 45 分钟内；
- 复杂度收益大于额外 artifact/dependency/rerun 风险。

若新 cold/warm 已达 SLO，Ticket 08 标记为 `not needed`，不为了理论并行度继续扩大
workflow 拓扑。

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
