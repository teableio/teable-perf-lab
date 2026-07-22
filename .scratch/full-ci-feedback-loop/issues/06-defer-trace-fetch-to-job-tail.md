# 06 — Defer trace retrieval to a bounded job tail

**What to build:** 让所有 measured cases 先完成操作、readiness 和结果写入，再在 execute job 尾部统一 flush、settle、选择并有界抓取 trace。批处理仍为每个 case/engine 生成独立、可对账的 manifest，并复用 partial-loss budget/breaker。

**Blocked by:** 03 — Bound trace evidence cost during partial Jaeger loss.

**Status:** ready-for-agent

- [ ] case primary metric 与 case execution wall 不包含 Jaeger settle/fetch 等待。
- [ ] 一个 execute job 只执行有界次数的 exporter flush 与 settle，不再为每个 case 固定等待。
- [ ] job-level selection/fetch 保持 case/engine/step 归属，raw snapshots 和 manifest 路径不串线。
- [ ] job trace budget 达到后，所有尚未抓取 refs 都获得明确 skipped/breaker reason。
- [ ] trace tail 失败或进程中断时，已经完成的 perf result 不丢失，每个受影响 case 都有可解释的 trace 状态。
- [ ] report consumers 继续读取兼容的轻量 manifest，raw trace artifact 仍按既有用途保留。
- [ ] 健康与 partial-loss 合成运行证明 job tail 分别完整保存代表和在 60 秒预算内退出。
