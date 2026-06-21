# Worklog: 性能实验室架构深化 / Perf Lab Architecture Deepening

- Date: 2026-06-21
- Type: Coding
- Project: teable-perf-lab
- Tags: architecture, perf-lab, agent-docs, reporting, workflow, record-read
- Impact: Medium

## Summary

本次对话围绕 `teable-perf-lab` 做了一轮架构深化：先扫描代码库并产出中文 HTML 总结，然后按低风险候选项落地抽象、补齐校验、更新 Agent 文档，最后做了合并前审查。最终本地 `main` 比 `origin/main` 领先 4 个架构/文档提交，完整 `pnpm check` 已通过，未发现合并阻塞项。

## Work Done

- 运行 `$improve-codebase-architecture` 方向的代码库审视，聚焦“哪些抽象值得深化”，并回答了几个判断问题：
  - 当前代码库整体已经比较规整，所以可落地优化集中在确定性高、边界清楚的内部模型抽取。
  - 仍有优化点，但不适合继续用大范围重构推进；后续应按具体风险面单独开任务。
  - Agent 必须知道的新增规则需要写进项目文档，而不是只停留在一次性报告里。
- 提交 `29ca8f5 refactor: extract perf workflow run plan`：
  - 新增 `scripts/run-plan.mjs`，把 GitHub Actions 里的 engine/case/execute matrix 解析从 inline Node 脚本抽出来。
  - 新增 `scripts/check-run-plan.mjs`，覆盖 `v1,v2`、`all`、hybrid computed split、非法 engine、空 case filter 等规则。
  - 更新 `.github/workflows/teable-ee-e2e-perf.yml`，让 resolve-plan job checkout perf-lab 后调用脚本。
  - 将 `check:run-plan` 接入 `package.json` 的 `pnpm check`。
- 提交 `a3ee7b6 refactor: centralize perf artifact read model`：
  - 新增 `scripts/perf-artifact-read-model.mjs`，集中 artifact payload 发现、文件命名、fallback payload、primary metric、trace URL、trace waste 等读模型。
  - 迁移 `scripts/report-teable-result.mjs` 和 `scripts/send-feishu-perf-summary.mjs`，让入口脚本主要保留 I/O。
  - 新增 `scripts/check-perf-artifact-read-model.mjs`，覆盖嵌套 artifact 目录、seed 过滤、legacy fallback、trace URL 和 trace waste。
  - 将 `check:artifact-read-model` 接入 `pnpm check`。
- 提交 `9df5255 refactor: deepen perf reporting and record-read models`：
  - 新增 `scripts/perf-run-summary-model.mjs`，把 Feishu 性能汇总卡片、job timing、退化排序、结果计数抽成纯模型。
  - 新增 `scripts/check-perf-run-summary-model.mjs`，覆盖耗时格式、job timing、pass/skipped/fail 统计、退化判定和卡片关键字段。
  - 新增 `scripts/perf-artifact-diff-model.mjs`，把 artifact diff 的 normalize/masking 规则从 CLI 中抽出。
  - 新增 `scripts/check-perf-artifact-diff-model.mjs`，覆盖“同语义不同噪声应通过”和 `verifiedSamples.actual` 改变应失败。
  - 新增 `framework/runners/record-read-model.ts`，把 record-read 的字段命名、fixture shape、公式期望值、投影字段、配置形状验证抽成纯模型。
  - 新增 `scripts/check-record-read-model.mjs`，覆盖 50 字段投影、fixture 数据、公式/lookup 期望值、字段解析和错误路径。
  - 缩小 `scripts/send-feishu-perf-summary.mjs`、`scripts/diff-artifacts.mjs`、`framework/runners/record-read.runner.ts` 的入口职责。
  - 将 `record-read-model.ts` 加入 record-read seed hash 输入，避免模型逻辑变更却复用旧 seed。
  - 将 `check:run-summary-model`、`check:artifact-diff-model`、`check:record-read-model` 接入 `pnpm check`。
- 提交 `7694e2b docs: map perf lab deepened modules`：
  - 更新 `README.md` File Map，记录 `framework/runners/*-model.ts`、artifact read model、run summary model、artifact diff model 的职责边界。
  - 更新 `AGENTS.md` 和 `.agents/README.md`，让 Agent 知道新增 check 链路与模型文件分工。
- 做合并前审查：
  - 当前分支为 `main`，状态是 `## main...origin/main [ahead 4]`。
  - 审查范围为 19 个文件，`2734 insertions(+), 1758 deletions(-)`。
  - 确认未改动高风险 case/contract 面：`cases/**`、`registry.ts`、`framework/types.ts`、`framework/artifacts.ts`。
  - 阅读并核对主要风险入口：workflow run plan、artifact read model、Teable report、Feishu summary、artifact diff、record-read runner/model。
  - 判断这批改动属于内部架构深化，不是 case 行为扩展，也不是 artifact writer schema 变更。

## Output

- Added/changed architecture modules:
  - `scripts/run-plan.mjs`
  - `scripts/perf-artifact-read-model.mjs`
  - `scripts/perf-run-summary-model.mjs`
  - `scripts/perf-artifact-diff-model.mjs`
  - `framework/runners/record-read-model.ts`
- Added model checks:
  - `scripts/check-run-plan.mjs`
  - `scripts/check-perf-artifact-read-model.mjs`
  - `scripts/check-perf-run-summary-model.mjs`
  - `scripts/check-perf-artifact-diff-model.mjs`
  - `scripts/check-record-read-model.mjs`
- Updated docs for future agents:
  - `README.md`
  - `AGENTS.md`
  - `.agents/README.md`
- Updated entrypoints to delegate to models:
  - `.github/workflows/teable-ee-e2e-perf.yml`
  - `scripts/report-teable-result.mjs`
  - `scripts/send-feishu-perf-summary.mjs`
  - `scripts/diff-artifacts.mjs`
  - `framework/runners/record-read.runner.ts`
  - `package.json`

## Evidence

- `pnpm check` passed after the latest docs commit. The chain included:
  `format:check`, `check:yaml`, `check:ts`, `check:types`, `check:trace`,
  `check:catalog`, `check:run-plan`, `check:artifact-read-model`,
  `check:run-summary-model`, `check:artifact-diff-model`,
  `check:record-read-model`, `check:cases`, and `check:readme`.
- `git diff --check origin/main..HEAD` produced no output.
- `git diff --name-only origin/main..HEAD -- cases registry.ts framework/types.ts framework/artifacts.ts` produced no output.
- `pnpm check:cases` dry-run listed 55 registered perf cases and confirmed metadata sync shape.
- `README.md Available Cases list is up to date.`

## Decisions

- Keep shared pure logic in model modules, while leaving GitHub, Feishu, Teable, filesystem, and runner I/O in thin adapters.
- Treat `record-read-model.ts` as seed-affecting source and include it in seed hash inputs.
- Do not touch case definitions, registry, config types, artifact writer schema, thresholds, metrics, or row counts in this optimization batch.
- Do not continue into broader protected-surface changes from the architecture scan; those require dedicated tasks and stronger runtime proof.

## Open Items

- Push/merge this local `main` after this worklog is committed and `pnpm check` is rerun.
- Remote GitHub Actions still needs to run after push; local readiness is green, but CI is the final remote signal.

---

## Review (Claude, 2026-06-21)

独立复核了 Codex 的 4 个提交（`29ca8f5`/`a3ee7b6`/`9df5255` 重构 + `7694e2b` 文档）。结论：**这批改动是忠实的纯抽取，没有发现行为变更，没有合并阻塞项。** 复核方法是把每个被抽取模块的“旧内联代码”和“新 model + 瘦入口”逐函数对比，再独立复跑 `pnpm check`。

### 核对过的事实

- **行为保留：四个抽取全部逐函数比对一致。**
  - `run-plan.mjs`（CI matrix）：engines/case 解析、cache-key 正则与 `slice(0,160)`、`v2-sync-default` / `v2-hybrid-computed` 分裂、错误顺序都与旧 heredoc 一字不差；workflow 这次只新增了 `Checkout perf lab` 步骤并把内联脚本换成 `node perf-lab/scripts/run-plan.mjs`，没动别的。校验失败时仍是非零退出（`process.exitCode = 1`，在 `set -euo pipefail` 下会让步骤失败）且**不会写出半截 GITHUB_OUTPUT**——与旧的 `process.exit(1)` 等价。
  - `perf-artifact-read-model.mjs`、`perf-run-summary-model.mjs`、`perf-artifact-diff-model.mjs`、`record-read-model.ts`：均为“纯移动 + 加 `export` + 参数化注入 env”。`diff-artifacts.mjs` 的整套 mask/normalize 规则（43 处 mask）旧新完全一致——**没有新增、删除、放宽或收紧任何 mask**，这是 G1 守卫最敏感的地方，重点确认过。
- **seed-hash 接线正确。** `record-read.runner.ts` 的 `seedCodeFiles` 确实新增了 `./record-read-model.ts`，而 `seed-cache.ts` 的 `hashFiles` 是按**文件内容**哈希的，所以改 model 里的公式/字段名会改 seedHash → 强制换 seed 表名 → 不会复用旧 seed。worklog 的这条声明是真的、且生效。
- **新 check 全部有效且接入 `pnpm check`。** 我本机 `pnpm check` 退出码 0，13 步全绿（含 5 个新 check）。它们断言的是具体期望值（不是“返回真值”这种空跑），diff-model 还双向验证了“同语义不同噪声 => PASS / 真值变化 => FAIL”。
- **受保护面未触碰：** `cases/**`、`registry.ts`、`framework/types.ts`、`framework/artifacts.ts` 无改动；文档（README File Map / AGENTS.md / .agents/README.md）指向的都是真实文件，描述与实际分层一致。

### 发现的问题与处理

1. **【已修】唯一“新写”的逻辑此前无任何编译期/测试保护。** 这批改动几乎全是搬运，唯一真正新增的代码是 `record-read.runner.ts` 里的 `fieldTypeByModel` / `toCreateFields`——把 model 输出的字符串类型映射回 `FieldType.*`。原写法是 `as const` 字面量映射：若将来 model 的 `FieldModel["type"]` 多出一种类型，这个映射会**静默**得到 `undefined` 并建出坏字段，`check:types` 不一定拦得住。本次 review 已把它改成穷举 `Record<FieldModel["type"], FieldType>`（`record-read.runner.ts:180-186`），并加了注释——现在 model 多出类型会在 `check:types` 处**响亮报错**，符合“出错要响”的原则，且不破坏 model 的零依赖边界。
2. **【已修】record-read 两条配置校验抛错此前没测。** `pageSize > 1000` 和 `rowCount % pageSize !== 0` 两条 `assertConfigShape` 分支之前无 `assert.throws` 覆盖。本次已补进 `scripts/check-record-read-model.mjs`（构造 `pageSize:1001` / `rowCount:9999,pageSize:1000` 让目标分支先触发）。`pnpm check` 复跑退出码 0。
3. **【已记录·非阻塞】check 是“引擎级守卫”，不是“逐规则回归套件”——尤其 artifact-diff。** “真值变化 => FAIL”这一向只用了一个语义字段（`verifiedSamples.actual`）做样例；几十个 case 专属 mask 是**间接**受保护的（任何人改动共享的 `normalize`/`shouldMaskKey` 都会被现有断言抓到），但单条 mask 没有被逐个钉住。含义：将来若有 agent 只收窄某个 case 的单条 mask、又没碰被测字段，这个 check 不一定能拦住——这点和“逐 case 审 mask 摆放”的习惯一致，新增/修改 case mask 时需人工留意。
4. **【已记录·非阻塞】其余良性覆盖盲点，不涉及行为变更：** run-summary 的 `formatDuration` <10s 小数分支、orange/green 头部模板、`workflowFailed` 分支未测；read-model 的 check 在断言前先 `.sort()`，所以没验证模型自身的排序，且 `resolvePrimaryTraceUrl` 因测试数据带 `traceLink` 而短路了 saved-trace 过滤 / 优先级正则分支。这些是新共享模块上的未测表面，不是本批引入的回归；若后续要更稳可补，但不影响合并。

### 最终判断

Codex 这批是忠实的纯抽取，行为零变更；本次 review 发现的两个真实缺口（#1、#2）已就地修复并通过 `pnpm check`（退出码 0），#3/#4 为已记录的非阻塞覆盖说明。**可保持已推送的 `main`，等远端 CI 复跑一遍作为最终远端信号。** 不需要回滚或返工。

> 注：本次 review 对 `record-read.runner.ts` 和 `scripts/check-record-read-model.mjs` 的两处修复，连同本 review 小节，一起提交在本批之后的 review commit 中；远端推送仍由维护者决定。
