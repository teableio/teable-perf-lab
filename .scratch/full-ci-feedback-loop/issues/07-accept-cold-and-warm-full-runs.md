# 07 — Accept cold and warm full-run feedback SLOs

**What to build:** 在同一 commit 和相同 full-run case 集合上，先安全制造 exact seed cache miss 完成一次 cold run，再立即完成一次 exact-hit warm run；用 artifact 而非 job 颜色验证反馈时间、coverage、routing、seed reuse、trace 对账和报告链路。

**Blocked by:** 04 — Reuse compatible seed dumps across safe plan changes; 05 — Balance shards with stage-aware costs; 06 — Defer trace retrieval to a bounded job tail.

**Status:** in-progress-full-ci

- [ ] Cold active workflow wall 不超过 45 分钟，Warm active workflow wall 不超过 25 分钟；runner queue 单独报告。
- [ ] Cold run 明确证明 exact miss，Warm run 明确证明同一计划 exact hit，不把 compatible restore 冒充 warm acceptance。
- [ ] 所有选中 case/engine 结果完整，pass/skip/fail 与预期一致，routing assertions 不退化。
- [ ] 同一物理 seed 不跨 shard 重复构建，artifact 中的 seed identity 与 planner affinity 一致。
- [ ] 每个 execute job 的 trace tail 不超过 60 秒，case attribution 不超过 15 秒，全部 refs 可由 saved/failed/skipped 对账。
- [ ] Feishu、Performance Track 和 GitHub summary 成功，且不重新触发 100KB/1MB payload 限制。
- [ ] 不放宽 case threshold、不减少 measured samples、不删除保留的 scale-up case 来取得通过。
- [ ] run ids、阶段耗时、关键 shard、预测误差和 cache/trace 证据回写到 spec 或验收记录，供下一轮校准使用。
