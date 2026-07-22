# 02 — Keep every physical seed fixture in one shard

**What to build:** 让 full-run planner 在计划时获得 authoritative seed affinity identity，并把同一物理 fixture 的所有 case 作为不可拆分 bundle。首个完整切片覆盖已知 100k numeric record-read 与 100k search-index families，同时让检查能阻止未来相同错误再次进入 CI。

**Blocked by:** 01 — Establish full-run feedback-loop regression gates.

**Status:** completed

- [x] 三个 100k numeric record-read siblings 在 full plan 中位于同一个 seed shard。
- [x] 两个 100k search-index siblings 在 full plan 中位于同一个 seed shard。
- [x] planner-visible affinity 来自 seed contract 的 authoritative identity，而不是仅靠命名约定。
- [x] 任意一个 affinity 跨 shard、重复声明、引用未知 case 或跨 V2 mode 时，快速检查明确失败。
- [x] 运行 telemetry 中相同 `seedHash` 出现在多个 shard 时，评估入口给出静态 affinity 漏洞诊断。
- [x] 所有 full-run case 仍恰好出现一次，精确 filter 仍可运行默认全量中被替换的小尺寸 case。
- [x] 现有 accepted affinity families 和 execute artifact mapping 不退化。
