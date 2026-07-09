---
docModules:
  - platform
docTopics:
  platform: 企业微信身份识别
canonicalDocs:
  - /permission-system
status: todo
---

# 企微通讯录 API 身份识别 TODO

## 背景

企微 AI Bot 长连接回调中，用户身份目前只能从 `body.from.userid` 获取。例如：

```text
from.userid = wofvtgBgAAnfJpH24lr99a5QoP3QinaQ
```

现有 Samata 逻辑会把该 raw userid 解析为本地 canonical user，并通过 `user_aliases` 维护外部身份映射；但仅凭回调 payload，无法自动判断真实姓名、部门、手机号或邮箱。

进一步识别用户需要调用企业微信通讯录 API：

1. 使用 `corpid + corpsecret` 获取 `access_token`。
2. 使用 `access_token + userid` 调用读取成员接口。
3. 将返回的成员姓名作为 Samata 用户显示名，并辅助管理员判断 alias 合并。

当前阻塞：暂时没有可用于通讯录读取的应用 `SECRET` 或通讯录同步 `SECRET`，因此本次不落地 API 调用，仅记录 TODO。

## 当前决策

- 不复用 `bot_apps.secret` 作为通讯录凭证；它当前用于企微 AI Bot 长连接认证，语义上不等同于通讯录应用 secret。
- 后续应单独配置通讯录凭证，优先使用环境变量保存敏感信息，避免写入文档、memory 或运行时数据库中的明文长期记忆。
- 拿到凭证前，企微身份仍以 `from.userid`、本地 canonical user、`user_aliases` 为准。
- 通讯录查询失败不得阻断用户对话，应降级为当前的 raw userid 解析和新用户通知流程。
- 初期只建议落库 `name` 到 `users.display_name`；手机号、邮箱等敏感字段默认不落库，若需要展示也应脱敏并限制在管理员调试场景。

## 预期实现路径

### 配置

建议新增环境变量：

```text
WEWORK_CONTACT_CORP_ID=wwxxxxxxxx
WEWORK_CONTACT_SECRET=xxxxxxxx
```

如未来需要多企业或多 bot，可在 `bot_apps.config` 中只保存环境变量名，例如：

```json
{
  "contact": {
    "enabled": true,
    "corpIdEnv": "WEWORK_CONTACT_CORP_ID",
    "secretEnv": "WEWORK_CONTACT_SECRET"
  }
}
```

### 技术选择

- 新增轻量封装模块 `src/wework/contact-api.ts`。
- 使用原生 `fetch` 调用企微 API，避免新增依赖。
- 在模块内缓存 `access_token` 和过期时间，提前刷新，避免每条消息都请求 token。
- 对企微错误码做可观测日志，但不向普通用户暴露 secret、token 或完整敏感 profile。

### 数据流

```text
企微 WS 回调
  -> src/wework/bot.ts 读取 body.from.userid
  -> src/wework/contact-api.ts 查询企微成员资料
  -> src/wework/session.ts 创建/刷新会话
  -> src/auth/rbac.ts resolveExternalUserWithStatus()
  -> users.display_name 使用通讯录 name 回填
  -> user_aliases 继续保存 wework_user_<raw userid>
```

## 受影响模块

- `src/wework/contact-api.ts`
  - 新增模块，负责 `gettoken`、`user/get`、token 缓存、错误降级。
- `src/wework/bot.ts`
  - 在文本、图片、文件、未知消息、反馈卡片事件等入口拿到 raw userid 后尝试查询成员资料。
  - `/debug` 可展示通讯录命中状态、成员姓名、部门摘要和降级原因。
- `src/wework/session.ts`
  - `getSession()` 支持接收来自通讯录的 displayName/profile 摘要。
- `src/auth/rbac.ts`
  - 继续保持 canonical id 与 alias 规则不变，只把 displayName 作为可更新的人类可读信息。
- `.env.example`
  - 增加通讯录凭证配置示例和安全说明。
- `tests/unit/wework/*`
  - 覆盖 token 缓存、读取成员成功、读取成员失败降级、display_name 回填、缺少 SECRET 时不请求 API。

## TODO

- [ ] 获取可用于通讯录读取的企微 `corpid`。
- [ ] 获取应用 `SECRET` 或通讯录同步 `SECRET`，并确认应用可见范围包含需要识别的成员。
- [ ] 如企微后台要求，配置服务器可信 IP。
- [ ] 新增 `src/wework/contact-api.ts`。
- [ ] 将通讯录查询接入企微消息处理入口。
- [ ] 更新 `/debug` 输出，便于管理员判断 alias 合并。
- [ ] 补充单元测试和 `.env.example`。
- [ ] 上线前确认不落库敏感字段，日志不打印 token/secret。

## 验证计划

拿到 SECRET 并实现后，至少执行：

```bash
npm run test:unit -- tests/unit/wework
npm run test:unit -- tests/unit/config/wework-session.test.ts tests/unit/config/rbac.test.ts
rg -n "WEWORK_CONTACT|contact-api|user/get|gettoken" src tests .env.example docs/plan
```

手工验证：

- 企微单聊发送 `/debug`，确认显示 raw userid、Samata canonical user、alias 和通讯录姓名。
- 使用无通讯录权限或错误 SECRET 启动，确认消息仍可正常进入当前 raw userid 身份解析流程。
- 新 raw userid 首次发消息时，确认管理员通知仍包含原始回调上下文。

## 本次改动

- 新增本 TODO 文档。
- 不修改运行时代码。
- 不新增依赖。
- 不修改数据库 schema 或运行时数据。
- 不需要重新构建 Docker image、插件构建产物，也不需要重启服务。

## 提交状态

- 基线 commit：`1b713e9`
- 本 TODO commit hash：待提交
