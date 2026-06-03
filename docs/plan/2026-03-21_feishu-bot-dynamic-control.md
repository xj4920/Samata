# 执行计划: 飞书 Bot 动态启停支持

## 需求背景
目前飞书 Bot 只能在 `feishu-entry` 启动时通过 `auto_start` 配置一次性加载。用户希望能够在不重启服务的情况下，通过 CLI 手动启动或停止特定的飞书 Bot。

## 方案设计
采用“基于数据库状态的任务同步”方案，避免复杂的进程间通信。

1.  **数据库轮询**: 在 `src/feishu/bot.ts` 中增加一个 `watchFeishuApps` 功能，由 `feishu-entry` 启动时运行。它会定期（如 10s）检查数据库。
2.  **状态同步逻辑**:
    - 如果 `auto_start = 1` 且应用未运行 -> 启动它。
    - 如果 `auto_start = 0` 且应用正在运行 -> 停止它。
3.  **CLI 命令增强**: 
    - 修改 `src/commands/agent.ts`，完善 `agent feishu-app enable/disable` 命令。
    - 增加 `agent feishu-app start/stop` 作为 `enable/disable` 的别名，并提示用户变更将在 10s 内生效。

## 影响范围
- `src/feishu/bot.ts`: 增加轮询逻辑。
- `src/feishu-entry.ts`: 启动轮询。
- `src/commands/agent.ts`: 优化命令输出和交互。

## 实施步骤
1. 修改 `src/feishu/bot.ts` 增加 `watchFeishuApps` 函数。
2. 修改 `src/feishu-entry.ts` 在 `main` 函数中调用该监控函��。
3. 修改 `src/commands/agent.ts` 增加更直观的启停命令。

## 验收标准
1. 在 CLI 执行 `agent feishu-app enable <app_id>`，观察 `feishu-entry` 日志，确认 Bot 自动上线。
2. 在 CLI 执行 `agent feishu-app disable <app_id>`，观察日志确认 Bot 自动下线。
3. 不影响已有的 `auto_start` 逻辑。
