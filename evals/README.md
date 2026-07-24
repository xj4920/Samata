# Samata 回归评测数据集

这里保存三类彼此隔离的评测资产：

- `cases/`：冻结 fixture 的 Agent 场景回归，不访问真实业务系统。
- `contracts/`：staging 真实工具契约，直接调用工具、不经过 LLM。
- `canary/`：production 真实 Agent + 真实只读工具的低频 Canary。

生产日志只用于生成候选，不直接进入 Git。真实 ID、凭证、业务数据和工具完整响应
不得写入 case 或正式报告，动态测试数据使用环境变量注入。

## 状态与审核

- `draft`：候选骨架，尚未进入门禁。
- `approved`：已补齐断言和审核信息，可由对应 runner 执行。
- `quarantined`：存在已知不稳定性，保留但不作为门禁。
- `deprecated`：历史 case，仅用于追溯。

正式 baseline 只能在干净工作区生成。历史回答仅用于人工参考，测试判定以
`assertions` 和 `judge` 为准。

## Live 评测保护

- `npm run eval:full` 只加载 `cases/`，不会加载 Contract/Canary。
- `npm run eval:contract -- --dry-run` 与 `npm run eval:canary -- --dry-run` 只检查
  case、环境变量和安全策略，不初始化外部连接。
- Contract live 要求 `EVAL_TARGET=staging`、专用 `EVAL_USER_ID` /
  `EVAL_AGENT_ID` 和 case 声明的 seed 变量。
- Canary live 要求 `EVAL_TARGET=production`、`ALLOW_PROD_CANARY=1`、专用
  `CANARY_USER_ID` / `CANARY_AGENT_ID` / `CANARY_CHANNEL` /
  `CANARY_TARGET_ID`。
- `controlled_delivery` 会产生真实投递，只能指向专用测试会话；独立 CLI 不支持
  构造企微 WebSocket 投递上下文。

首批 Contract 中知识库覆盖 `search_knowledge`、`read_knowledge_document`、空结果
和跨 Agent 权限拒绝。依赖 staging seed 或外部专有系统的 case 在完成 live 验证前
保持 `draft`。
