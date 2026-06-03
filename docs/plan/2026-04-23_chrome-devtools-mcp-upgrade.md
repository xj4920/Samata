# 用 chrome-devtools-mcp 替换 @playwright/mcp

## 背景

原方案通过 `@playwright/mcp` 连接 Windows 宿主机 Chrome CDP（端口 9222），提供约 14 个浏览器自动化工具。

Google 官方的 [`chrome-devtools-mcp`](https://github.com/ChromeDevTools/chrome-devtools-mcp)（34K stars, Apache-2.0）是其超集，共 34 个工具，额外提供：

- **Performance**: 录制 trace + 分析 Core Web Vitals
- **Network**: 查看完整请求/响应 body
- **Debugging**: console messages、JS eval、Lighthouse 审计
- **Memory**: 堆快照
- **Emulation**: 网络/CPU 限速、地理位置、暗色模式

## 改动

| # | 文件 | 改动 |
|---|------|------|
| 1 | `package.json` | `npm uninstall @playwright/mcp` + `npm install -D chrome-devtools-mcp` |
| 2 | `config/mcp-servers.json` | server 名 `browser` → `devtools`，command 改为 `chrome-devtools-mcp@latest --browser-url` |
| 3 | `src/llm/agents/config.ts` | `TOOL_PRESETS.browser` 工具名更新为 `mcp_devtools_*` 命名，添加调试/性能/网络工具 |
| 4 | 本文档 | 计划归档 |

## 工具命名变化

- 旧：`mcp_browser_browser_navigate` → 新：`mcp_devtools_navigate_page`
- 旧：`mcp_browser_browser_click` → 新：`mcp_devtools_click`
- 旧：`mcp_browser_browser_take_screenshot` → 新：`mcp_devtools_take_screenshot`
- 新增：`mcp_devtools_lighthouse_audit`、`mcp_devtools_performance_*`、`mcp_devtools_take_memory_snapshot` 等

| 4 | `src/llm/agents/config.ts` | `getAgentTools()` 的 `standard` 模式加入 `getMcpTools()`，与 plugin 同等自动包含 |

## 无需改动

- `src/services/mcp-manager.ts` — MCP 客户端已通用
- `src/llm/agent.ts` — `mcp_` 前缀路由已存在
- DB migrations — MCP 工具在 `standard` 模式下自动包含，无需逐工具写 migration

## 验证

1. Windows 启动 Chrome debug（`--remote-debugging-port=9222`）
2. WSL 确认连通：`curl -s http://<HOST_IP>:9222/json/version`
3. `npm run server`，日志应显示 `MCP [devtools] (npx): 已连接，34 个工具`

## 状态

- [x] 已执行完成
