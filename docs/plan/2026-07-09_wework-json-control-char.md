# 企微 JSON 控制字符解析修复

## 背景

2026-07-09 企微 `wework-bot` 收到用户直接粘贴的原始 FIX 报文后没有反馈。生产日志显示 SDK WebSocket 层在进入 Samata 消息 handler 前报错：

```text
Failed to parse WebSocket message: Bad control character in string literal in JSON
```

原因是 FIX 报文使用 SOH (`0x01`) 作为字段分隔符，企微长连接回调的 raw JSON 中包含未转义控制字符，第三方 `@wecom/aibot-node-sdk` 内部 `JSON.parse(raw)` 直接失败，消息无法进入 `otcclaw` 对话链路。

## 决策

- 不修改 `node_modules`，不引入 `patch-package`。
- 在 Samata 的企微 WebSocket 工厂内安装项目级补丁，替换 SDK `WsConnectionManager` 的 message 解析路径。
- 正常 JSON 先走原生 `JSON.parse`；只有失败时才扫描 raw JSON，并仅转义 JSON 字符串内部未转义的 `0x00-0x1F` 控制字符。
- 不改变 JSON 字符串外的合法空白字符，不二次处理已转义内容；非控制字符造成的畸形 JSON 继续抛错。

## 改动清单

- `src/wework/aibot-ws.ts`
  - 新增 `escapeJsonStringControlChars()`、`parseWeworkWsJsonFrame()`。
  - 新增 `installWeworkJsonControlCharPatch()`，在创建企微 `WSClient` 前安装补丁。
- `tests/unit/wework/aibot-json-sanitizer.test.ts`
  - 覆盖原始 SOH、多控制字符、已转义内容、非控制字符畸形 JSON、SDK message 分发路径。
- `package.json` / `package-lock.json`
  - 版本号从 `3.0.27` 递增到 `3.0.28`。

## 验证命令

```bash
npm run test:unit -- tests/unit/wework/aibot-json-sanitizer.test.ts
npm run test:unit -- tests/unit/services/deliver.test.ts tests/unit/config/wework-session.test.ts
git diff --check -- .
npx tsc --noEmit
```

## 验证结果

- `npm run test:unit -- tests/unit/wework/aibot-json-sanitizer.test.ts`：通过，1 个测试文件、5 个测试。
- `npm run test:unit -- tests/unit/services/deliver.test.ts tests/unit/config/wework-session.test.ts`：通过，2 个测试文件、9 个测试。
- `git diff --check -- .`：通过。
- `npx tsc --noEmit`：失败，剩余错误均在未改动文件 `src/services/mcp-manager.ts`，为既有 `ParsedLogyiDate | null` 与 `ParsedLogyiDate | undefined` 类型不匹配问题。

## 构建影响

本次改动影响 OtcClaw 主运行时代码，不涉及数据库迁移、依赖新增、插件构建产物或 SQLite 运行库。若上线 Docker 环境，需要重新构建并推送 OtcClaw 主镜像，然后重启对应容器；当前尚未执行镜像构建、推送或重启。

## Commit Hash

- 实现提交：待提交后回填。
