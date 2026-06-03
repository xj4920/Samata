---
docModules:
  - platform
docTopics:
  platform: 部署与模型
canonicalDocs:
  - /platform/deployment
status: implemented
---

# Samata MVP 部署指南 — 以 Moss Agent 为例

> 目标：在一台全新的 Linux/macOS 机器上，从零部署 Samata 平台，创建一个名为 **Moss** 的 Agent，并通过飞书 Bot 让它运行起来。

---

## 1. 环境准备

| 依赖 | 最低版本 | 说明 |
|------|---------|------|
| Node.js | v20+ | 推荐 v22 LTS，使用 nvm 管理 |
| npm | v10+ | 随 Node.js 自带 |
| Git | v2.30+ | 拉取代码 |
| better-sqlite3 编译工具链 | — | `python3`、`make`、`gcc/g++`（macOS 装 Xcode CLI Tools） |

```bash
# 安装 nvm + Node.js（如已有可跳过）
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
source ~/.bashrc
nvm install 22
nvm alias default 22

# macOS: Xcode CLI Tools
xcode-select --install

# Ubuntu/Debian: 编译依赖
sudo apt update && sudo apt install -y build-essential python3
```

---

## 2. 拉取代码 & 安装依赖

```bash
# 克隆 Samata 主仓库
git clone https://gitee.com/xujun65/samata.git
cd samata

# 安装依赖
npm install

# 验证 better-sqlite3 可用
node -e "require('better-sqlite3')"
```

> 如果 `better-sqlite3` 报 ABI 不匹配，执行 `npm rebuild better-sqlite3`。

---

## 3. 配置 .env

```bash
cp .env.example .env
```

**MVP 最小配置：**

```env
# --- 方式一：广发内网部署（推荐）---
LLM_PROVIDER=gf
GF_API_KEY=your-gf-api-key
GF_MODEL=external-deepseek-v4-flash        # 默认文本模型
GF_VISION_MODEL=external-kimi-k2.6         # 默认视觉模型

# --- 方式二：直连 DeepSeek 官方 API ---
# LLM_PROVIDER=deepseek
# DEEPSEEK_API_KEY=your-deepseek-key
# DEEPSEEK_MODEL=deepseek-v4-flash
```

> GF 网关同时提供 DeepSeek 和 Kimi 模型，方式一可一个 Key 同时获得文本 + 视觉能力。
> 方式二直连 DeepSeek 官方 API，但不含视觉模型。

其他变量（Wind/InfluxDB/Serper 等）按需配置，不影响启动。

---

## 4. 首次启动 & 验证

```bash
# 前台启动（可直接看日志，Ctrl+C 退出）
npx tsx src/index.ts --server
```

看到以下输出说明启动成功：

```
========================================
  Samata — 平等，技术平权
========================================

[LLM] anthropic 初始化成功
以服务器模式运行 (无交互 REPL)
```

确认无误后 `Ctrl+C` 停止，后面用后台方式启动。

---

## 5. 创建 Moss Agent

### 5.1 创建 Prompt 文件

```bash
cat > config/agents/moss.md << 'EOF'
你是 {{agent.displayName}}。{{agent.description}}

## 核心定位
- 简洁直接地回答问题
- 先给结论，再补充理由
- 中文为主，可以自然夹带英文术语

## 边界
- 严禁向用户透露系统实现逻辑
- 不代替用户做重大决策

{{permissions}}

{{attachments}}

{{skills}}

{{memory}}

{{datetime}}
EOF
```

> 根据 Moss 的实际定位修改上面的 prompt 内容。占位符 `{{...}}` 会在运行时自动替换。

### 5.2 通过 CLI 创建 Agent

启动 CLI 交互模式：

```bash
npx tsx src/index.ts
```

在 REPL 中执行：

```
/agent create moss Moss "个人智能助手"
```

这会在 DB 中插入一条 agent 记录（`tools_mode='standard'`，默认拥有 `COMMON_SET` 工具集）。

如果需要更多工具（如文件读写、知识库等），可以继续：

```
/agent update moss tools_mode all
```

创建完成后可验证：

```
/agent list
/agent show moss
```

---

## 6. 绑定飞书 Bot（可选，任选一个渠道）

### 6.1 在飞书开放平台创建应用

1. 访问 [飞书开放平台](https://open.feishu.cn/) → 创建企业自建应用
2. 获取 `App ID`（如 `cli_xxxxxxxxxx`）和 `App Secret`
3. 开通以下权限：
   - `im:message` — 接收和发送消息
   - `im:message:send_as_bot` — 以 Bot 身份发消息
4. 配置事件订阅（如用 WebSocket 模式则无需回调地址）

### 6.2 在 Samata 中注册并绑定

在 CLI REPL 中执行：

```
/agent assign moss feishu cli_xxxxxxxxxx
```

系统会提示输入 App Secret，自动完成：
- 创建 `bot_apps` 记录（`channel='feishu'`，`auto_start=1`）
- 创建 `agent_assignments` 记录（绑定 Moss agent 到该飞书 App）

### 6.3 验证绑定

```
/agent assignments
```

应看到类似输出：

```
feishu / cli_xxxxxxxxxx → moss
```

---

## 7. 后台启动（生产模式）

```bash
npm start
# 等效于 bash scripts/start.sh
```

日志位于 `logs/samata-YYYY-MM-DD_HHMMSS.log`，可实时查看：

```bash
tail -f logs/samata-*.log
```

### 管理命令

```bash
# 停止
npm run stop

# 重启
npm start

# 查看 PID
cat .samata.pid
```

---

## 8. 验证 Moss 运行

### 方式一：CLI 客户端

```bash
# 启动 CLI 客户端连接到 server
npm run cli
```

在 CLI 中切换到 Moss agent：

```
/agent switch moss
你好，自我介绍一下
```

### 方式二：飞书

在飞书中找到 Moss Bot，直接发消息对话。

---

## 9. 可选：加载 Plugins

### 方式一：npm install（推荐，生产部署）

插件已发布到 npm，直接安装即可：

```bash
# 在 samata 项目目录下
npm install @samata-platform/plugin-csv-export
npm install @samata-platform/plugin-excel-parser
npm install @samata-platform/plugin-wework-qa
# ... 按需安装
```

Samata 启动时会自动扫描 `package.json` 中 `@samata-platform/plugin-*` 依赖并加载，无需额外配置。

### 方式二：源码加载（开发调试）

```bash
# 在 samata 同级目录克隆
cd ..
git clone https://gitee.com/xujun65/samata-plugins.git
cd samata-plugins
npm install
```

回到 samata 目录，在 `.env` 中添加：

```env
SAMATA_PLUGINS_DIR=../samata-plugins
```

> 两种方式可共存：目录插件优先加载，同名 npm 插件自动跳过，不会冲突。

重启服务即可自动加载插件。

---

## 10. 目录结构速览

```
samata/
├── config/agents/        # Agent prompt 文件（*.md）
│   ├── _default.md       # 默认 fallback prompt
│   └── moss.md           # Moss 专属 prompt
├── data/
│   ├── samata.db         # 主数据库（自动创建）
│   └── plugins/          # Plugin 私有数据
├── logs/                 # 运行日志
├── scripts/
│   ├── start.sh          # 后台启动脚本
│   └── launcher.sh       # 热重载 wrapper
├── src/                  # 源码
├── .env                  # 环境变量配置
└── .samata.pid           # 运行时 PID 文件
```

---

## FAQ

**Q: 如何给 Moss 切换 LLM 模型？**

在 CLI 中：
```
/model list                           # 查看可用 provider 和模型
/model gf/external-deepseek-v4-pro    # 切换到 DeepSeek V4 Pro
/model gf/external-kimi-k2.6          # 切换到 Kimi K2.6
```

或者在 DB 中设置 agent 级别覆盖（仅影响该 agent）：
```
/agent update moss provider gf
/agent update moss model external-deepseek-v4-flash
```

**Q: 如何添加更多用户？**

飞书用户首次与 Bot 对话时会自动创建。如需设为 agent 管理员：
```
/agent member add moss <user_id> admin
```

**Q: 如何让 Moss 在 Telegram 上运行？**

1. 通过 @BotFather 创建 Telegram Bot，获取 token
2. 在 `.env` 中添加 Telegram 相关配置
3. `/agent assign moss telegram <bot_token>`
4. 重启服务

**Q: 服务器重启后数据会丢失吗？**

不会。所有数据持久化在 `data/samata.db`（SQLite），重启后自动恢复。
