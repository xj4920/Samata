---
docModules:
  - platform
docTopics:
  platform: 场景回归评测
canonicalDocs:
  - /platform/scenario-regression
status: implemented
---

# OTCClaw 业务查询回归 Case

## 背景

用户于 2026-07-22 连续向 OTCClaw 查询北向极速客户、最近交易日北向极速规模和当前
北向常速交易规模，并确认将这三次请求提取为 approved 场景回归 case。对应 telemetry
turn hash 为：

- `38ec8c8c974a236baed2b671`
- `99ba23c93308522ef823c094`
- `020075c86e93ff81a024acb8`

Telemetry 仅保存了截断预览，且第三次请求的原始工具轨迹包含不应进入测试资产的连接
信息。因此本次只保留问题、不可逆 hash、时间和工具语义，不复制生产回答或原始工具
输入输出。

## 核心决策

- 三个 case 均由用户明确确认后设为 `approved`，归入 `business_query`。
- 客户查询只使用合成客户名、阶段和标签，不保存联系人、销售、群组、需求、费率等
  业务资料；fixture 混入一个仅有“常速”标签的客户，验证回答确实完成极速筛选。
- 极速与常速规模均使用合成金额，并保持多空、名义本金与当日成交额的加总关系。
- 最近交易日由冻结查询结果返回，避免测试随真实时间和交易日历漂移；日期工具可以
  调用但不强制，因为只读汇总工具已经提供最新有数据的交易日。
- 常速查询只允许只读汇总工具，明确禁止 `sandbox_exec` 和
  `sync_normal_trading_summary`，防止回归评测复现直连或写入动作。
- 图片渲染与发送保留为可选冻结工具；通过标准以只读查询、日期、关键规模结论和预算
  硬断言为准，不启用不稳定的 LLM Judge。

## 改动清单与数据流

- 新增北向极速客户列表 case。
- 新增最近交易日北向极速规模 case。
- 新增当前北向常速交易规模 case。
- `business_query` 从 1 个 approved case 增至 4 个，达到单场景 3～5 个的目标区间。

```text
telemetry 问题 + 不可逆 turn hash
  -> 人工安全审查
  -> 合成客户 / 合成金额 / 冻结日期 fixture
  -> 当前 OTCClaw agent loop + 真实模型
  -> 冻结只读工具回放
  -> 工具、顺序、答案事实、禁用工具与预算硬断言
```

## 验证命令

- `npm run eval:validate`
- 三个新增 case 分别执行 Full 3 次重复
- `npm run eval:smoke`
- `npm run eval:full`
- `npm run eval:self-test`
- `npx tsc --noEmit`
- `git diff --check`
- 新增资产敏感信息模式扫描
- `npx vitepress build docs`

## 验证结果

- 首轮三个 case 各 3 次定向回放后，客户查询有 1 次把 8 条匹配记录误数为 7；fixture
  随后调整为明确返回已按“极速”过滤的 8 条记录，并对 8 个合成客户逐一断言。
- 首轮极速规模 3 次均直接调用 `trade_summary` 并给出正确日期和规模，没有调用
  `calculate_date`；由于查询结果本身已提供最近有数据的交易日，删除非必要的日期工具
  强制断言，保留日期结论断言。
- 首轮常速规模 3 次的只读工具、日期、规模和多空结论均正确；断言补充模型实际使用的
  “成交金额”同义表达。
- 第二轮客户与极速规模均 3/3 通过；常速规模 2/3，通过横向表格表达时“名义本金”与
  合计值之间包含两个分项，超过原 24 字符窗口。断言仅将该布局窗口放宽至 96 字符，
  日期、330 亿、5 亿和空头结论仍全部强制验证。
- 客户与极速规模最终定向 3 次通过证据来自 Run ID
  `501654e8-45af-48e2-9422-56e5db0d05b0`；常速规模最终定向 3/3 通过，Run ID
  `ddca3c01-b8cb-436b-bd17-ca174dd7a0b2`。
- Case schema 校验通过：共 12 个 approved case，`business_query` 为 4 个；最终 Full
  case set hash 为 `9ce1fb499ff173462f8c2d76f6a66ef133872a75580158631145ea0eeef0f099`。
- 最终 Smoke 通过：9/9 case、9/9 repetitions，Run ID
  `f13a3e57-0673-486e-b77f-122d9bbda847`。
- 最终 Full 通过：12/12 case、36/36 repetitions，Run ID
  `866d79db-6914-47a0-81ab-92a926e9007c`；耗时范围 3003～19630 ms，中位数
  5597 ms，非正耗时为 0。
- `eval:self-test` 通过：8 个测试文件、18 个测试；`npx tsc --noEmit` 通过。
- 新增资产未命中常见凭据模式；生产客户、规模和连接信息均未写入 case。
- `npm run docs:build` 通过并刷新 PLAN 索引；同步脚本仍报告仓库既有历史 PLAN 缺少
  frontmatter 或 canonical target 的问题，本次 PLAN 未被点名，VitePress 构建成功。
- 用户随后运行 Full（Run ID `97ab7872-c3ef-4799-bde8-3fae4077a5ee`）时，客户列表
  Case 第 2 次 repetition 正确调用 `query_clients`、列出全部 8 个客户，但回答使用
  “8 位”；断言 `8\s*(个|家)` 未覆盖该量词，导致假阴性并使 Case 为 2/3。用户确认
  后将数量断言调整为 `8\s*(个|家|位)`；8 个客户逐一出现、正确工具和预算等断言均未
  放宽。
- 将上述失败 Run 的第 2 次 repetition 重新送入硬断言后全部通过；随后客户列表定向
  Full 3/3 通过，Run ID `82091eda-454a-455c-87db-34916cbd2801`。其中第 1 次回答再次
  使用“8 位”，其余两次使用“8 家”，三次均保留全部客户事实并通过。

## 构建与运行影响

- 只增加评测数据和 PLAN 文档，不修改生产 Agent、工具、依赖、数据库 schema 或运行时
  构建产物。
- 不需要重新构建 Docker image、执行数据库迁移或重启服务。

## Commit Hash

- 实现提交：待用户确认提交后回填。
