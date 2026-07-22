# 03 — Bound trace evidence cost during partial Jaeger loss

**What to build:** 保留完整 trace refs 和真实缺失告警，同时按语义 request shape 限制 raw snapshot 抓取，并为部分丢失引入 case/job budget 与熔断状态。Jaeger 健康时仍保存有用代表；Jaeger 可连接但 trace 永久缺失时，不再逐条空等到超时。

**Blocked by:** 01 — Establish full-run feedback-loop regression gates.

**Status:** implemented-awaiting-full-ci

- [x] 高重复 GET 与 POST 都按 request shape 选择有限代表，全部 refs 仍保留在 manifest。
- [x] 结构不同的写 step 不会共享代表；同 shape 代表只能覆盖真正等价的重复操作。
- [x] healthy、exporter hard outage、Jaeger hard outage、partial loss 和 recovery probe 都有确定性测试。
- [x] partial loss 达到阈值后停止剩余长轮询，并把 skipped/missing/wasted/breaker reason 完整写入 manifest。
- [x] 一个 shape 至少有一个成功代表时其余 refs 可解释地 skipped；全部代表缺失时仍显示失败或 partial-loss 告警。
- [x] case 归因 trace wait 不超过 15 秒，execute job trace budget 不超过 60 秒。
- [x] saved、failed 与 skipped 总数可以和全部 refs 对账，不通过关闭 sampling、清空 refs 或隐藏 dashboard 告警达标。
