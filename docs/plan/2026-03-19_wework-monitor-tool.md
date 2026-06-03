---
docModules:
  - platform
  - plugins
docTopics:
  platform: 渠道与会话
  plugins: 后台服务插件化
canonicalDocs:
  - /platform/channels-and-sessions
  - /plugins/catalog
status: implemented
---

# 企微监测 Tools 化计划

## Context

用户希望将现有的 `/watch start|stop|status` CLI 命令封装为 agent tools，并限制只有 alter-ego agent 有权限使用。

目前 `/watch` 命令已有完整实现：
- `src/services/wework-monitor.ts` — `startMonitor()`, `stopMonitor()`, `isMonitorRunning()`
- `src/commands/router.ts:53` — `handleWatch()` CLI 入口

## 需要修改的文件

1. `src/llm/agent.ts` — 添加工具定义 + handler + executeTool case
2. `src/db/schema.ts` — 将新工具加入 alterEgoTools 列表，并添加 migration

## 实现步骤

### 1. agent.ts — 添加工具定义（紧接 extract_wework_qa 之后）

```typescript
{
  name: 'wework_monitor',
  description: '控制企微消息监测服务。支持启动、停止、查询状态。仅 alter-ego 可用。',
  input_schema: {
    type: 'object' as const,
    properties: {
      action: { type: 'string', description: "'start' | 'stop' | 'status'" },
    },
    required: ['action'],
  },
},
```

### 2. agent.ts — 添加 handler（紧接 handleExtractWeworkQA 之后）

```typescript
function handleWeworkMonitor(input: { action: string }): string {
  const currentAgent = getCurrentAgent();
  if (currentAgent?.name !== 'alter-ego') {
    return JSON.stringify({ error: '权限不足：wework_monitor 仅 alter-ego 可用' });
  }
  const action = input.action?.trim().toLowerCase();
  if (action === 'start') {
    startMonitor();
    return JSON.stringify({ success: true, message: '企微监测已启动' });
  } else if (action === 'stop') {
    stopMonitor();
    return JSON.stringify({ success: true, message: '企微监测已停止' });
  } else if (action === 'status') {
    return JSON.stringify({ running: isMonitorRunning() });
  }
  return JSON.stringify({ error: "action 必须为 'start' | 'stop' | 'status'" });
}
```

顶部 import：
```typescript
import { startMonitor, stopMonitor, isMonitorRunning } from '../services/wework-monitor.js';
```

### 3. agent.ts — executeTool 添加 case

```typescript
case 'wework_monitor': return handleWeworkMonitor(input);
```

### 4. schema.ts — alterEgoTools seed 数据添加 'wework_monitor'

### 5. schema.ts — 添加 migration，对已有数据库自动补入 'wework_monitor'

## 权限说明

- otcclaw 是 `tools_mode='all'`，allowlist 过滤对它无效
- 因此在 handler 内部通过 `getCurrentAgent()?.name !== 'alter-ego'` 做二次鉴权
- tutor/doctor 等 allowlist agent 因工具列表不含 `wework_monitor`，自然无法调用

## 验证方式

1. 切换到 alter-ego agent，调用 `wework_monitor` with `action: 'status'` — 应返回 `{ running: false }`
2. 调用 `action: 'start'` — 应启动监测服务
3. 切换到其他 agent（如 otcclaw），调用同一工具 — 应返回权限不足错误
