# Session 持久化与用户记忆注入（纯文件版）

日期: 2026-04-22

## 核心概念

Workspace = (用户 x Agent)，以 md 文件存储用户偏好和对话摘要，注入 system prompt 实现个性化上下文。零 SQLite 改动、零 memory 表 schema 变更。

## 文件结构

```
data/workspaces/
  {agentName}/
    {userId}.md     # 每个 (用户, Agent) 组合一个文件
```

## 数据流

1. 用户对话 → 内存中的 `history[]`（和之前一样）
2. 会话结束（timeout 2h / `/reset` / destroy）→ LLM 摘要 → 追加到 workspace md
3. 下次对话 → `buildSystemPrompt` 读取 workspace md → `{{user_context}}` 占位符注入

## 改动文件

### 新建
- `src/session/workspace.ts` — workspace md 文件读写（load/write/update）
- `src/session/summarizer.ts` — LLM 摘要 + 偏好提取，fire-and-forget

### 修改
- `src/llm/agents/prompt.ts` — `buildSystemPrompt` 注入 `user_context` 变量
- `config/agents/*.md` — 所有 agent 模板增加 `{{user_context}}` 占位符
- `src/wework/session.ts` — cleanup/reset 触发摘要
- `src/feishu/session.ts` — 同上
- `src/telegram/session.ts` — 同上
- `src/server/cli-session.ts` — reset/destroy 触发摘要

## 配置

摘要使用 `summary` 任务类型，可通过环境变量路由到轻量模型：
- `MODEL_SUMMARY` — 摘要模型（默认跟随主模型）
- `PROVIDER_SUMMARY` — 摘要 provider（默认跟随主 provider）
