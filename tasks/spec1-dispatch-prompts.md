# Spec 1 dispatch prompts (reusable)

Copy-paste prompts for dispatching the implementing agent (codex) and the review
agent for the runner-framework deepening. Fill the one placeholder: the
implementing agent's branch name (`$BR`) once it reports back.

Related docs: `tasks/spec1-runner-driver-skeleton.md` (the spec),
`tasks/spec1-review-guide.md` (the review runbook),
`tasks/spec1-migration-tracker.md` (what is/ isn't migrated).

> Spec 1 status: Part B (driver + record-delete/undo/redo migration) is done on
> `refactor/runner-lifecycle-driver`. The implementing agent works Part A
> (registry) + Part C (diff-artifacts) + G1 on its own branch off that branch.

---

## Prompt A — implementing agent (codex)

```text
仓库:/Users/leo/tea/tea-project/teable-perf-lab(remote: teableio/teable-perf-lab)

起点:从已 push 的分支 refactor/runner-lifecycle-driver 切出你自己的新分支
(例如 codex/spec1-registry-and-g1)。在你这个分支上干活并 push,不要直接提交到
refactor/runner-lifecycle-driver,也不要切到无关分支。

先读:tasks/spec1-runner-driver-skeleton.md(完整规格)、tasks/spec1-review-guide.md
(你的产出会被另一个 agent 按这份 guide 审,务必让它的每一项 PASS)、README.md、
.agents/README.md、.agents/seed-execute.md、.agents/skills/localrun/SKILL.md。

硬约束:改动只留在本仓库,绝不编辑 ../teable-ee;不改 case id、artifact JSON
schema(framework/artifacts.ts 的形状)、framework/types.ts 的 config 接口、
registry.ts、cases/**;收尾前 pnpm check 必须绿;不要删除或还原工作区里已存在的
.DS_Store 和 tasks/v2-trace-bsp-drop-blocker.md。

Part B 已经做完(framework/runners/record-replay-lifecycle.ts + 三个迁移好的
record-{delete,undo,redo}.runner.ts)——研读、当模板,不要重做。你要完成三件:

1) Part A —— 新建 framework/runner-registry.ts,一张 PerfRunnerKind -> {execute, seed}
   的登记表,把 framework/run-perf-case.ts 的 runCaseByKind 和
   framework/run-perf-seed.ts 的 seedCaseByKind 两个 switch 换成查表。纯改写、零
   行为变化:每个 kind 的表项必须调用与原 switch 完全相同的函数、相同参数;
   record-delete|record-undo|record-redo 的 seed 项要转发 perfCase.runner 给
   seedRecordUndoRedoCase(perfCase, context, perfCase.runner);
   http-endpoint|record-paste|table-create 的 seed 项要逐字节复现原来的 skipped
   对象;unknown kind 仍然 throw;条目数与 framework/types.ts 的 PerfRunnerKind
   union 一一对应,不多不少。

2) Part C —— 新建 scripts/diff-artifacts.mjs(仿 scripts/check-trace-classification.mjs
   的风格:纯 Node + node:assert + 打印 ok/fail + 设 process.exitCode)。接收两个
   artifact JSON,按 spec「Part C」掩掉易变字段后逐字段深比较,有实质差异就失败。
   注意:只能掩真正每次跑都会变的字段(时间戳、durationMs、指标的数值、生成的 id、
   seedHash、整个 details.observability);绝不能掩语义字段(指标 key、phases[].name
   及顺序、thresholds[].metric/max/unit、details.operation、details.replaySetup 的
   键、路由 engine/engineMatched/routeMatched/feature、verifiedSamples[].expected、
   rowCount、batchSize)。先用「同一份代码跑两遍 diff 出噪音」的方法反推掩码。

3) G1 验证 —— 在 main(迁移前)和你的分支(迁移后)各跑一遍下面三个 case 的 v1+v2,
   用 scripts/diff-artifacts.mjs 对每个 case×引擎比对 main↔分支,必须全部无实质差异;
   并自测对比器「改坏一个语义字段就会失败」。本地跑法:先用
   .agents/skills/localrun/scripts/inject-perf-lab.sh 注入沙箱,再在
   /Users/leo/tea/tea-project/teable-ee-perf-local/enterprise/backend-ee 下:
     PERF_LAB_CASE_FILTER='record-delete/delete-1k,record-undo/delete-1k,record-redo/delete-1k' \
     PERF_LAB_ENGINE_LIST=v1,v2 PERF_LAB_MODE=execute \
     PERF_LAB_ARTIFACT_DIR=<dir> NEXT_BUILD_ENV_EDITION=CLOUD \
     NODE_OPTIONS='--max-old-space-size=4096' \
     npx vitest run --config ./vitest-perf-lab.config.ts
   (Docker 的 teable-postgres / teable-cache 需在跑。)

完成标准:两个 switch 消失且行为不变;scripts/diff-artifacts.mjs 存在、能正确失败、
main↔分支 diff 对 3 case×v1×v2 全过;pnpm check 绿。不要迁移其他 runner 家族,也不要
做 Spec 2~4 的护栏。最后 push 你的分支,并把分支名报回来。
```

## Prompt B — review agent

```text
仓库:/Users/leo/tea/tea-project/teable-perf-lab

你的任务:审阅 codex 对「Spec 1」的 Part A(登记表)+ Part C(产物对比器)+ G1
验证结果。要审的分支名是:<在这里填 codex 报回来的分支名>。

唯一的指引文档:tasks/spec1-review-guide.md。从头到尾读完并逐步执行它——它是为你
这种无上下文的全新 agent 写的冷启动 runbook,里面有:背景、路径、Docker 前置、用
git worktree 取 main↔分支两套产物的完整命令、登记表等价的核对方法、强制的「证明
对比器会失败」测试、可掩/不可掩字段两张清单、以及每个 case 的黄金参照表。

重点(文档里也强调了):codex 自己写对比器又用它证明自己没改坏——你必须独立审它的
掩码有没有掩到语义字段、并亲手改坏一个产物确认对比器真的会报错。绝不能只看
pnpm check 绿就放行。

你只做审阅,不要修改代码、不要替它修 bug。产出按文档第 10 节:每个 section 给
PASS/FAIL(各附你实际跑的命令和看到的输出)、列出需要人判断的点及结论、最后一行
给 merge / fix-then-merge(列出具体要改的) / reject 的建议。用大白话写,面向不读
代码的项目负责人。完成后不要删 worktree 以外的东西,沙箱和 teable-ee 保持原样。
```
