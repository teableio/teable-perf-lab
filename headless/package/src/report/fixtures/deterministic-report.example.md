# Headless 基准确定性测试报告

> 本报告明确区分数据来源与证据类型；结论仅覆盖下列范围。

## 执行摘要

- 正确性判定：通过
- 证据类型：确定性测试数据
- 执行状态：通过
- 性能判定：未比较
- 场景目录：cat\_determin…
- 当前场景：scn\_determin…
- 本次执行：exe\_determin…

- 该确定性 fixture 的读取结果符合预期。（置信度：高；证据：check\_row\_co…、op\_list\_reco…）

## 范围、数据与运行环境

此报告仅验证报告格式、中文渲染和离线行导出。

- 纳入：单表读取；计算队列排空
- 完整场景目录：2 个场景（详细 ID 见附录）
- 本次配置：本次只配置本地 PGlite 场景。
- 数据集：deterministic\-test\-data；固定种子生成的两行测试数据，不代表生产负载。
- 行数：Tasks=2
- 后端：进程内 PostgreSQL（PGlite） 0\.3\.14
- PostgreSQL：17\.4
- 主机：darwin\-test / arm64 / deterministic\-cpu
- 提交：0123456789abcdef0123456789abcdef01234567；工作区干净
- 运行时间：2026\-01\-02T03:04:05\.000Z 至 2026\-01\-02T03:04:06\.000Z（1000 ms）
- 计算语义：写入包含同步内联工作；flush 单独测量剩余异步排空工作。

### 排除项

- 跨区域网络：确定性测试不访问网络

## 覆盖与缺口

- 请求 2；适用 2；计划 1；执行 1
- 通过 1；失败 0；跳过 0；不支持 1
- 规则：计划 1，执行 1
- 来源：计划 1，执行 1
- 边：计划 1，执行 1
- 汇总由测试批次证据记录合并派生，不是独立填写的覆盖声明。

### 缺口汇总

- 不支持：1 个场景
- 各场景的完整 ID 与原因见“详细证据附录”。

## 基线比较

未提供基线，因此没有性能比较结论。

## 最慢操作

| 执行 / 场景                     | 顺序 | 操作     | 阶段        |  p95 | 尝试 / 成功 / 错误 |
| ------------------------------- | ---: | -------- | ----------- | ---: | -----------------: |
| exe\_determin… / scn\_determin… |    0 | 读取记录 | measurement | 4 ms |          3 / 3 / 0 |

## 实际阶段与操作顺序

- 0. exe\_determin… / measurement / op\_list\_reco…：实际读取操作
- 1. exe\_determin… / drain / op\_flush\_com…：显式排空步骤没有成功样本

## 正确性

### 本次执行 exe\_determin…（场景=scn\_determin…；物化 case=case\_determi…；运行=run\_determin…）

- 正确性=通过；执行=通过；性能=未比较
- 返回行数：通过；方法=精确 JSON 比对；期望=2；实际=2；容差=\{"kind":"exact"\}

## 方法

- 百分位：最近秩百分位；公式：x\_\(ceil\(p\*n\)\)，样本按升序排列，索引从 1 开始；不平均百分位。
- 分位数是数学描述，不等于统计保证。p95 至少需要 20 个独立样本、p99 至少需要 100 个，最近秩才可能低于最大样本；达到该分辨率也不保证尾部稳定或置信度。低于分辨率时性能证据不足，不可判性能通过。
- 本报告的独立性能 SLO 只针对 p95；p99 始终是描述性估计，不参与性能通过判定。p99 达到 100 个样本也不表示获得独立置信保证。
- 未执行配对 Bootstrap：确定性测试数据不包含真实配对实验，不能据此推断性能。
- 假设：每个原始样本使用同一单位；报告百分位直接从原始样本计算

### 中文术语说明

- 最近秩百分位（nearest-rank）：样本排序后，直接取 `ceil(p × n)` 对应的观测值，不在相邻值之间平均。
- 进程内 PostgreSQL（PGlite）：在当前进程内运行、用于本地基准的 PostgreSQL 兼容数据库。
- 完整重算（full-recompute）：增量路径与重建路径共享同一 Teable 计算引擎；只证明两条执行路径的状态一致，不是独立公式语义 oracle。
- 混合内联与排空（hybrid inline/flush）：写入时包含同步内联计算，之后再显式排空剩余异步计算。
- 排空（flush）：等待尚未完成的计算任务处理完毕；其耗时只代表剩余异步工作。
- 测试批次证据记录（suite receipt）：某个测试批次对一个场景的适用性、计划、执行状态及规则/来源/边覆盖证据。

## 局限与警告

### 各操作分位数分辨率

| 操作         | 成功样本 | p95（至少 20）         | p99（至少 100；仅描述）  |
| ------------ | -------: | ---------------------- | ------------------------ |
| 读取记录     |        3 | 未达到分辨率，证据不足 | 未达到分辨率，仅数学估计 |
| 排空计算队列 |        0 | 未达到分辨率，证据不足 | 未达到分辨率，仅数学估计 |

- 局限：固定主机描述不代表真实硬件。
- 局限：此结论不能外推到生产环境。
- info / test\-data\-only：这是确定性测试数据，不是实际基准结果。

## 复现命令与产物

- 生成确定性报告（工作目录：\.）：'bun' '\-\-conditions=@teable/source' 'src/report/fixtures/deterministicExamples\.ts'
- test\-data\-json：src/report/fixtures/deterministic\-data\.json；SHA-256=806a9241b239b7a26b7cc1ce4de0be110e5cef7447f2e2417a65d5313a267413
- 数据哈希：806a9241b239b7a26b7cc1ce4de0be110e5cef7447f2e2417a65d5313a267413
- 测试数据哈希：806a9241b239b7a26b7cc1ce4de0be110e5cef7447f2e2417a65d5313a267413

## 详细证据附录

### 完整标识符

- 完整场景目录 ID：<code>cat_deterministic_001</code>
- 完整场景 ID：<code>scn_deterministic_001</code>
- 完整执行 ID：<code>exe_deterministic_001</code>
- 完整场景目录 ID 列表：
  - <code>scn_deterministic_001</code>
  - <code>scn_remote_unsupported</code>

### 测试批次与缺口明细

#### 测试批次 <code>suite_read</code> / 场景 <code>scn_deterministic_001</code>

- 证据记录：<code>receipt_suite_read</code>
- 适用=是；计划=是；执行=通过
- 执行引用：完整执行 ID <code>exe_deterministic_001</code> / 完整运行 ID <code>run_deterministic_001</code>
- 规则：计划 1，执行 1
  - rule\_filter：计划=是，执行=是，状态=通过
- 来源：计划 1，执行 1
  - source\_tasks：计划=是，执行=是，状态=通过
- 边：计划 1，执行 1
  - edge\_tasks\_owner：计划=是，执行=是，状态=通过

#### 测试批次 <code>suite_remote</code> / 场景 <code>scn_remote_unsupported</code>

- 证据记录：<code>receipt_suite_remote</code>
- 适用=是；计划=否；执行=不支持
- 执行引用：无（未执行）
- 说明：PGlite 测试后端不提供远程网络路径
- 规则：计划 0，执行 0
- 来源：计划 0，执行 0
- 边：计划 0，执行 0

- 缺口：场景 <code>scn_remote_unsupported</code>；不支持；PGlite 测试后端不提供远程网络路径

### 执行与正确性方法明细

#### 完整执行 ID：<code>exe_deterministic_001</code>

- 完整场景 ID：<code>scn_deterministic_001</code>
- 完整物化 case ID：<code>case_deterministic_001</code>
- 完整运行 ID：<code>run_deterministic_001</code>
- 返回行数：精确 JSON 比对；原始方法名：<code>exact-json</code>

### 统计方法原始标识符

- 百分位方法：最近秩百分位；原始方法名：<code>nearest-rank</code>
