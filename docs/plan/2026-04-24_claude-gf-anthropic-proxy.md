# 2026-04-24 Claude Code 接入广发 Anthropic 网关（本地拍平代理）

## 背景

广发内部 LLM 网关提供 Anthropic 协议入口：

```
http://llm.smart-zone-dev.gf.com.cn/api/anthropic/v1
```

但它遵循的是 Anthropic Messages API 的**子集**：`tool_result.content` 只接受 `string`，不接受官方规范允许的 `ContentBlock[]`。Claude Code 默认以 block 数组形式发送工具结果（便于嵌图/结构化结果），直连会被 400。

解决方案：在本地起一个最小代理，把 `tool_result.content` 数组拍平成字符串后再转发到广发。

等广发升级支持数组形式，把 `~/.claude/settings.json` 里的 `ANTHROPIC_BASE_URL` 改回 `http://llm.smart-zone-dev.gf.com.cn/api/anthropic` 并删除代理脚本即可。

## 变更清单

### 1. `scripts/claude-gf-proxy.ts`（新增）

纯 Node 原生 `http` 模块实现，无新增依赖：

- 从项目 `.env`（`dotenv/config`）读取：
  - `GF_API_KEY` — 注入上游 `x-api-key` / `Authorization: Bearer`
  - `CLAUDE_PROXY_PORT`（默认 `3458`，避开 server 的 `3457` 与 ccr 的 `3456`）
  - `CLAUDE_PROXY_HOST`（默认 `127.0.0.1`）
  - `CLAUDE_PROXY_UPSTREAM`（默认 `http://llm.smart-zone-dev.gf.com.cn/api/anthropic`）
- 行为：
  - 读取整个请求 body，若 `content-type` 为 `application/json` 就 parse
  - 遍历 `messages[].content[]`：对 `type === 'tool_result'` 且 `content` 为数组的，`text` 块取 `.text`、其他（image 等）`JSON.stringify` 作占位，用 `\n` 拼接替换
  - 重写 `content-length`，清掉客户端的 `x-api-key` / `authorization` / `accept-encoding`，注入 GF 密钥
  - 上游响应直接 pipe 回客户端（SSE / 非 SSE 统一透传）
  - 失败 502，把错误文本透传
  - 日志：`METHOD PATH -> STATUS ${ms}ms flattened=N`

### 2. `package.json`

新增启动命令：

```json
"claude-proxy": "tsx scripts/claude-gf-proxy.ts"
```

### 3. `~/.claude/settings.json`（全局用户配置，新建）

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:3458",
    "ANTHROPIC_MODEL": "external-deepseek-v4-pro",
    "ANTHROPIC_AUTH_TOKEN": "placeholder-handled-by-proxy",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1"
  }
}
```

- `ANTHROPIC_AUTH_TOKEN` 填占位值即可，真正的 GF 密钥由代理注入，避免密钥落到全局配置
- `ANTHROPIC_MODEL` 固定 `external-deepseek-v4-pro`

## 不改动

- 不动 samata 项目 `.env`（samata 内部走 `GF` provider 或其他，和 Claude Code 解耦）
- 不改 `src/llm/claude.ts` / `src/llm/gf.ts`，代理只服务于外部 Claude Code CLI
- 不加 npm 依赖

## 使用

```bash
npm run claude-proxy   # 启动代理，监听 127.0.0.1:3458
claude                 # 另起终端启动 Claude Code；读 ~/.claude/settings.json 自动走代理
```

## 验证

1. 端口监听：`ss -lntp | grep 3458`
2. 直连 smoke test：

   ```bash
   curl -sS -X POST http://127.0.0.1:3458/v1/messages \
     -H 'content-type: application/json' \
     -d '{"model":"external-deepseek-v4-pro","max_tokens":64,"messages":[{"role":"user","content":"hi"}]}'
   ```

3. 构造带 `tool_result.content` 为数组的请求，代理日志应显示 `flattened>0`，上游不再 400
4. `claude` CLI 发一条带工具调用的对话，能正常拿到回复

## 回滚

- 广发升级支持数组后：改 `~/.claude/settings.json` 的 `ANTHROPIC_BASE_URL` 为 `http://llm.smart-zone-dev.gf.com.cn/api/anthropic`，停掉 `npm run claude-proxy`，可删除 `scripts/claude-gf-proxy.ts` 和 `package.json` 里的 `claude-proxy` 脚本。
