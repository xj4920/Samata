---
docModules:
  - platform
docTopics:
  platform: 场景回归评测
canonicalDocs:
  - /platform/scenario-regression
status: implemented
---

# 近一个月高频问题回归 Case

## 背景

用户要求分析 2026-06-22 至 2026-07-22 的 Samata telemetry，从近一个月经常出现的
问题中提取一批 approved 场景回归 case。统计覆盖 30 个日志文件、494 个有效请求，
另有 13 次公司行为定时任务自动触发被排除，不作为人工提问频次。

语义归类显示，成交规模/多空/换手率、客户与交易对手信息、订单拒绝根因、SBL 使用率
和接口调用频率/RT 都有重复需求。公司行为、数据导出等高频场景已有 approved case，
本轮不重复增加。

## 核心决策

- 新增 5 个 approved case：交易对手 ID 映射、客户多空交易与换手率、SBL 使用率、
  拒单根因、接口调用频率与 RT。
- 只保留原始问题对应的不可逆 turn hash、观察时间和场景语义；不提交原始 telemetry
  报告、生产回答、真实客户、订单、证券、服务、接口、金额或日志。
- 所有工具输出使用 frozen 合成 fixture，并保留金额加总、比率和日志证据之间的关系。
- 使用最小工具 allowlist、必需工具次数、工具顺序、答案事实、禁用结论和预算硬断言；
  不启用 LLM Judge。
- 每个 case 在 Full 中执行 3 次以检测非确定性。新增 case 的 priority 设为 1，不替换
  各场景已有的 Smoke 样本，因此 Smoke 仍为 8 条单次执行。
- `incident_investigation` 两条新增 case 为 critical，3 次必须全部通过；其他 case 也按
  approved Full 回归标准执行 3 次。

## 改动清单与数据流

- `business_query`：新增客户交易对手 ID 映射，approved 数量由 4 增至 5。
- `complex_workflow`：新增客户多空交易/换手率和 SBL 使用率，approved 数量由 1 增至 3。
- `incident_investigation`：新增拒单根因和接口 RT，approved 数量由 1 增至 3。
- approved case 总数由 11 增至 16；Full repetition 总数由 33 增至 48。
- Full 校准既有 CSV 导出 case 的工具顺序提示和正常输出预算，避免并行工具消息与过窄
  token 上限造成非业务失败；不改变其工具、文件、行数或发送结果断言。
- Full 校准既有 memory 权限 case 的内部 loop round 上限由 3 调整为 4；实际
  `save_memory` 调用仍严格限制为 1 次，权限失败和禁止声称写入成功的断言保持不变。
- Full 校准既有北向极速规模 case 的等价业务术语与金额格式正则，接受“总存续规模”
  以及整数、一位和两位零小数；日期、金额数值和工具调用约束保持不变。
- 接口 RT case 使用错误数为 2 的正向断言验证失败请求，不使用会误伤“并非零错误”
  这类否定表达的简单负向子串断言。
- 换手率 case 的分母口径接受“名义本金”“名义金额”“存续规模”等等价业务术语，
  仍同时校验 15 亿、25 亿、166.67%、未经年化和两次工具的固定顺序。
- 公司行为空结果 case 接受“本地数据库中无……记录”这类中间带介词的标准空结果句式；
  SFTP 失败原因、工具顺序和禁止虚报同步成功的约束保持不变。
- 新增 case 的边界措辞接受“未年化”和“没有提供具体交易对手”这两个等价表达；
  换手率数值、拒单错误码、日志证据和禁止虚构实体的约束保持不变。

```text
过去一个月 telemetry
  -> 排除自动任务与非业务确认
  -> 相似问题语义归类和频次排序
  -> 选择尚未覆盖的高频场景
  -> 不可逆来源元数据 + 合成 frozen fixture
  -> 当前 Agent loop + 真实模型
  -> 工具轨迹、业务事实、证据和预算硬断言
```

## 验证命令

- `npm run eval:validate`
- 5 个新增 case 定向 Full 执行，每条 3 次，共 15 次
- `npm run eval:smoke`
- `npm run eval:full`
- `npm run eval:self-test`
- `npx tsc --noEmit`
- `npm run docs:build`
- `git diff --check`
- 新增评测资产敏感信息模式扫描

## 验证结果

- `npm run eval:validate`：通过；17 个 YAML、16 个 approved，最终全集 hash 为
  `8dccd6f329c4829984d11e11ad3153bad4e63d2b04fb8245201649dcc8eec2d4`。
- 最终 Smoke：8/8 通过，run ID
  `9fb3dd37-830d-433d-a9ec-2e5fe7e5a52c`。
- 最后一轮 Full 诊断：12/16 通过，run ID
  `891d639b-637f-4495-ba4f-b2420934fd06`。其中常速规模一次把 330 亿误写为
  33 亿，FIX case 一次使用 6 轮超过预算 5；这两项属于真实失败，未放宽断言。
  同轮换手率“未年化”和拒单“没有提供具体交易对手”属于等价措辞，已校准。
- 最终新增 case 定向复测中，换手率 3/3 通过；拒单根因 1/3 通过，另外两次回答
  虚构 `customers.json` 配置来源，正确命中禁止虚构配置的断言并保持失败。该失败作为
  当前 Agent 的待修复回归证据，不通过放宽 case 掩盖。
- `npm run eval:self-test`：8 个测试文件、18 个测试全部通过。
- `npx tsc --noEmit`：通过。
- `npm run docs:build`：通过；仅有仓库既有 plan frontmatter、语法高亮和 chunk 大小
  警告。
- `git diff --check`：通过；5 个新增 case 的凭证、连接串、URL、IP 和已知真实实体
  模式扫描无命中。
- `npm run docker:samata:build`：通过；生成
  `local/titans/otcclaw:v3.1.1-0722190641047`，image digest 为
  `sha256:fc7a72cbadd2ea90187acb2563ac3ce1d457952949c5def989476a9b09f77ec6`。

## 构建与运行影响

- 业务改动只涉及评测 YAML 和 PLAN 文档，不修改生产 Agent、工具实现、依赖或数据库
  schema，不需要数据库迁移或服务重启。
- 按仓库提交规范将根包版本从 `3.1.0` 升至 `3.1.1`；Docker tag 和 OCI version label
  来源于该版本，因此已重新构建对应 image；未 push image、未部署、未重启运行中服务。

## Commit Hash

- 实现提交：待用户确认提交后回填。
