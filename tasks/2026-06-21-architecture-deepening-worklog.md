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
