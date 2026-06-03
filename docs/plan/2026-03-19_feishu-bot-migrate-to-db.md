# feishu bot 凭证迁移到 DB + wework-monitor 使用 alter-ego 绑定

## Context

当前 feishu bot 凭证（appId/appSecret 等）存在 `config/monitor.json` 的 `feishuApps` 数组中，
而 agent ↔ bot 绑定关系存在 DB 的 `agent_assignments` 表中，两处数据存在一致性风险。

用户决定将 bot 凭证也迁移到 DB，`config/monitor.json` 中的 `feishuApps` 完全废弃。

架构说明：
- `alter-ego`、`otcclaw`、`tutor` 均为 **agent 实例**（`agents` 表中的具体行）
- `agent_assignments` 表已是 `(channel='feishu', app_id) → agent_id` 的映射
- wework-monitor 发通知应使用绑定了 `alter-ego` 实例的 feishu bot

## 修改方案

### 1. `src/db/schema.ts` — 新增 feishu_apps 表 + seed

```sql
CREATE TABLE IF NOT EXISTS feishu_apps (
  app_id             TEXT PRIMARY KEY,
  app_name           TEXT NOT NULL,
  app_secret         TEXT NOT NULL,
  verification_token TEXT NOT NULL DEFAULT '',
  encrypt_key        TEXT NOT NULL DEFAULT '',
  show_thinking      INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Seed 两条记录（INSERT OR IGNORE）：
- `cli_a93212c0b7b9dcc5` / `otcclaw-bot` / `Ngdd5bLmxpgawK9ol3qRsbT4Navnq4Xa`
- `cli_a9329f3af5b8dcc9` / `tutor-bot` / `l69uf6jF04uEY6Urcn8Tjff0ytTxVSgy`

### 2. `src/llm/agents/config.ts` — 新增 getFeishuAppByAgentName()

```typescript
export interface FeishuAppRow {
  app_id: string; app_name: string; app_secret: string;
  verification_token: string; encrypt_key: string; show_thinking: number;
}

export function getFeishuAppByAgentName(agentName: string): FeishuAppRow | null {
  const db = getDb();
  return db.prepare(`
    SELECT fa.* FROM feishu_apps fa
    JOIN agent_assignments aa ON fa.app_id = aa.app_id
    JOIN agents a ON aa.agent_id = a.id
    WHERE a.name = ? AND aa.channel = 'feishu'
    LIMIT 1
  `).get(agentName) as FeishuAppRow | null;
}
```

### 3. `src/feishu/bot.ts` — startAllFeishuBots 从 DB 读取

```typescript
import { getDb } from '../db/schema.js';
// 替换原来读 config/monitor.json feishuApps 的逻辑
const apps = getDb().prepare('SELECT * FROM feishu_apps').all() as FeishuAppRow[];
```

### 4. `src/services/wework-monitor.ts` — getFeishuNotifyApp() 改用 DB

```typescript
import { getFeishuAppByAgentName } from '../llm/agents/config.js';

function getFeishuNotifyApp(): FeishuAppRow | null {
  const app = getFeishuAppByAgentName('alter-ego');
  if (!app) {
    log.print('[monitor] 未找到 alter-ego 的飞书 bot，请在 feishu_apps 表中配置并绑定 alter-ego');
    return null;
  }
  return app;
}
```

移除 `MonitorConfig` 中的 `feishu` 和 `feishuApps` 字段。

### 5. `config/monitor.json` — 删除 feishuApps 数组

## 关键文件

- `src/db/schema.ts`
- `src/llm/agents/config.ts`
- `src/feishu/bot.ts`
- `src/services/wework-monitor.ts`
- `config/monitor.json`

## 验证

1. 启动应用，DB 自动创建 `feishu_apps` 表并插入两条 seed
2. `npx tsx src/feishu-entry.ts` 日志显示两个 bot 启动
3. wework monitor 启动，日志显示找到 alter-ego 绑定的 bot
4. 若未绑定，打印提示而非崩溃
