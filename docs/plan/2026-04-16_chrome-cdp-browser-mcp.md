---
docModules:
  - external-data
  - plugins
docTopics:
  external-data: Web 与浏览器
  plugins: Tool / Skill / MCP
canonicalDocs:
  - /external-data/web-and-browser
  - /plugins/sdk-and-lifecycle
status: implemented
---

# Windows 宿主机 Chrome CDP + Playwright MCP 方案

## 背景

otcclaw 的 `http_request` 工具（axios）是裸请求，不带浏览器 cookies/session，无法访问需要登录态的网页。需要让 agent 具备"带 cookies 浏览网页"的能力。

## 方案概述

在 Windows 宿主机上以 debug 模式启动 Chrome（开放 CDP 端口），WSL2 中通过 Playwright MCP 连接该 Chrome 实例。所有浏览器操作在宿主机 Chrome 上执行，天然带登录态。

### 架构图

```
Windows 宿主机                    WSL2 (otcclaw)
┌─────────────────┐              ┌──────────────────────┐
│ Chrome + CDP    │◄─── CDP ────│ Playwright MCP Server │
│ 127.0.0.1:9222  │  ws://      │ (stdio 进程)          │
└─────────────────┘              └──────────┬───────────┘
                                            │ stdio
                                 ┌──────────┴───────────┐
                                 │ otcclaw (MCP Client)  │
                                 │ mcp-manager.ts        │
                                 └──────────────────────┘
```

### 为什么选这个方案

- WSL2 到 Windows 宿主机网络天然互通，无需端口转发
- 直接复用日常 Chrome 的登录态 cookies
- otcclaw 已有完整 MCP 基础设施 + `TOOL_PRESETS.browser` 预设，零代码改动
- 链路最短、延迟最低

## 执行步骤

### Step 1: Windows 端 — 创建 Chrome Debug 启动脚本

创建 `scripts/launch_chrome_debug.bat`（放在 otcclaw 项目中但 gitignore）：

```bat
@echo off
set PORT=9222
set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"

echo Launching Chrome with remote debugging on port %PORT%...
start "" %CHROME% --remote-debugging-port=%PORT% --remote-allow-origins=*
echo Chrome started. CDP available at ws://localhost:%PORT%
pause
```

注意事项：
- 直接使用默认 Chrome profile，保留所有登录态
- 启动前必须先关闭所有 Chrome 窗口（同一 profile 不能被两个实例使用）
- 如不想关 Chrome，可加 `--user-data-dir=C:\Users\<用户名>\.chrome-debug` 用独立 profile

### Step 2: WSL2 端 — 安装 @playwright/mcp

```bash
npm install -D @playwright/mcp
```

### Step 3: 获取 Windows 宿主机 IP

```bash
cat /etc/resolv.conf | grep nameserver | awk '{print $2}'
```

验证 CDP 连通性：

```bash
curl -s http://<HOST_IP>:9222/json/version
```

### Step 4: 创建 config/mcp-servers.json

该文件已在 `.gitignore` 中，不会提交：

```json
{
  "servers": {
    "browser": {
      "command": "npx",
      "args": [
        "@playwright/mcp",
        "--cdp-endpoint", "ws://<WINDOWS_HOST_IP>:9222"
      ],
      "description": "Playwright MCP via Windows Chrome CDP"
    }
  }
}
```

关键：server 名为 `browser`，工具自动命名为 `mcp_browser_browser_*`，与 `src/llm/agents/config.ts` 中已有的 `TOOL_PRESETS.browser` 完全匹配。

### Step 5: 可选 — mcp-manager 支持环境变量替换

WSL2 宿主机 IP 可能在重启后变化。在 `src/services/mcp-manager.ts` 的 `loadConfig()` 中对 args 数组做 `$ENV_VAR` 替换：

```typescript
// 在 loadConfig() 返回前，对 args 中的 $VAR 做环境变量替换
for (const srv of Object.values(servers)) {
  if ('args' in srv && srv.args) {
    srv.args = srv.args.map(a => a.replace(/\$(\w+)/g, (_, k) => process.env[k] ?? _));
  }
}
```

这样 config 中可以写 `ws://$WSL_HOST_IP:9222`，启动时自动解析。

### Step 6: 验证

1. Windows 上运行 `launch_chrome_debug.bat`
2. WSL2 中 `curl -s http://<HOST_IP>:9222/json/version` 确认连通
3. `npm run server` 启动 otcclaw，观察日志：`MCP [browser] (npx): 已连接，14 个工具`
4. CLI 中测试 agent 用浏览器工具访问需要登录的页面

## 改动文件

| # | 文件 | 改动 |
|---|------|------|
| 1 | `scripts/launch_chrome_debug.bat` | 新增：Windows Chrome debug 启动脚本 |
| 2 | `package.json` | 新增 devDependency: `@playwright/mcp` |
| 3 | `config/mcp-servers.json` | 新增：browser MCP server 配置（gitignored） |
| 4 | `src/services/mcp-manager.ts` | 可选：loadConfig() 中 args 环境变量替换（约 3 行） |
| 5 | `.gitignore` | 确认 `scripts/*.bat` 或 `config/mcp-servers.json` 已被忽略 |

## 注意事项

- **Windows 防火墙** — 如 WSL2 无法连通 9222 端口，需在防火墙放行
- **Chrome 必须以 debug 模式启动** — 普通启动的 Chrome 不开放 CDP
- **同一 profile 限制** — 不加 `--user-data-dir` 时必须先关所有 Chrome 窗口
- **现有 `launch_chrome_debug.sh` 仍可用于 Mac 场景** — 两套脚本互不冲突

## 状态

- [x] 已执行完成
