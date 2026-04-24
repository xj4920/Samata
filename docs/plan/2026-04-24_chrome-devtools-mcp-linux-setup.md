# Chrome DevTools MCP — Linux 本机配置

## 背景

`chrome-devtools-mcp` 作为 MCP server 在 [src/services/mcp-manager.ts](../../src/services/mcp-manager.ts) 的 `initMcpServers()` 启动时被拉起，需要本机或远端有一个已开 CDP 的 Chrome。

迁移到当前 Linux 机器（hostname `xj-XPS-13-9360`）后出现以下 gap：

- [config/mcp-servers.json](../../config/mcp-servers.json) 原本指向 `http://172.19.32.1:9222`（WSL2 场景下的 Windows 宿主 IP），本机不可达
- `env.PATH` 指向 `/home/dministrator/.nvm/versions/node/v24.13.0/bin`，这个用户在本机不存在
- 本机未安装 Chrome，`9222` 无人监听
- `scripts/` 下只有 [scripts/launch_chrome_debug.bat](../../scripts/launch_chrome_debug.bat)（Windows 脚本），没有 Linux 版启动脚本

选定路线：**本机装 Chrome + 独立 profile 的 debug Chrome**（登录态持久化）。

## 数据流

```mermaid
flowchart LR
    samata["samata server (tsx)"] -->|stdio| mcp["npx chrome-devtools-mcp@latest"]
    mcp -->|"CDP ws://127.0.0.1:9222"| chrome["Chrome --user-data-dir=~/.chrome-debug"]
```

## 改动

| # | 文件 | 改动 |
|---|------|------|
| 1 | `google-chrome-stable_current_amd64.deb` | 下载到 `/tmp`，用户手动 `sudo apt install` |
| 2 | [scripts/launch_chrome_debug.sh](../../scripts/launch_chrome_debug.sh) | 新增：Linux 版 debug Chrome 启动脚本（幂等、自动 headless、独立 profile） |
| 3 | [config/mcp-servers.json](../../config/mcp-servers.json) | 新建到正确路径；`--browser-url=http://127.0.0.1:9222`；`env.PATH` 指向 nvm v24 解决 Node 版本 |

## 关键坑

### 1. 配置路径

[src/services/mcp-manager.ts](../../src/services/mcp-manager.ts) `loadConfig()` 读的是 `<repo>/config/mcp-servers.json`。仓库里还有个 `config/config/mcp-servers.json` 是历史遗留（未被任何代码引用），不要改那个。

### 2. Node 版本

`chrome-devtools-mcp@0.23.0` 要求 `node ^20.19.0 || ^22.12.0 || >=23`。

Cursor Server 捆绑的 Node 是 `v20.18.2`，在 `PATH` 里优先级比 nvm 更高，直接 `npx` 会 `EBADENGINE` 拒绝。

解决：在 `env.PATH` 里手动把 `/home/xj/.nvm/versions/node/v24.14.0/bin` 放最前面，让子进程用 nvm 的 Node。

注：`mcp-manager.ts` 的 `expand($VAR)` 只覆盖 `args` 和 `url`，不覆盖 `env`，所以这里只能硬编码绝对路径。文件本身在 `.gitignore` 中（`config/mcp-servers.json`），本机专属，不污染仓库。

### 3. SSH session 无 DISPLAY

通过 SSH 连接时没有 X server，普通 Chrome 启动会报 `Missing X server or $DISPLAY`。

启动脚本自动检测 `DISPLAY` / `WAYLAND_DISPLAY`，为空时自动附加 `--headless=new --disable-gpu --no-sandbox`，也可通过 `CHROME_HEADLESS=0/1` 强制覆盖。

## 验证

```bash
# 1. 启动 Chrome
bash scripts/launch_chrome_debug.sh

# 2. 确认 CDP
curl -s http://127.0.0.1:9222/json/version
# 应返回 JSON，含 "Browser": "Chrome/..."

# 3. 冒烟测试 MCP server（可选，不启动主程序）
PATH=/home/xj/.nvm/versions/node/v24.14.0/bin:$PATH \
  timeout 5 npx --yes chrome-devtools-mcp@latest \
  --browser-url=http://127.0.0.1:9222 --no-usage-statistics
# 应看到 "chrome-devtools-mcp exposes content..." 的 banner 后 hang 住（等 stdio 输入）

# 4. 完整集成
npm run server
# 日志应出现：✅ MCP [devtools] (npx): 已连接，34 个工具
```

## 状态

- [x] 已执行完成

## 后续维护

- nvm 升级 Node 后，记得同步更新 [config/mcp-servers.json](../../config/mcp-servers.json) 的 `env.PATH`
- 如果 Cursor Server 的 Node 升到 >= 20.19，就可以移除 `env.PATH` 覆盖，让子进程继承默认 PATH
- 换机器时：重新 `bash scripts/launch_chrome_debug.sh`，并把 `env.PATH` 指向新机器 nvm node 路径
