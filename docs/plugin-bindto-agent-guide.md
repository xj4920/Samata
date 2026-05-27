# Plugin 绑定 Agent 操作指南

插件创建完成并被 Samata 加载后，如果其 `scope` 为 `agent-bound`，还需要将工具名显式加入目标 agent 的 `tools_list` 才能生效。

## 1. 前置条件确认

### 1.1 插件目录已配置

确认 `.env` 中 `SAMATA_PLUGINS_DIR` 包含插件所在父目录：

```env
SAMATA_PLUGINS_DIR=../samata-plugins,../samata-plugin-work,../samata-plugin-private
```

### 1.2 插件已成功加载

启动服务后日志应出现：

```
✅ Plugin [etf-monitor]: 2 tools loaded
```

若未出现，检查插件目录是否有 `index.ts` 且 `export default` 了合法的 `PluginModule`。

### 1.3 确认插件 scope

打开插件 `index.ts`，查看 `scope` 字段：

- **`universal`**（默认）— 自动对所有 `standard` 模式 agent 可见，**无需后续步骤**
- **`agent-bound`** — 必须执行下面的配置步骤

## 2. 添加 Migration（标准方式，进 git）

在 `src/db/schema.ts` 文件**末尾**追加一个 `runOnce(...)` 幂等 migration。

### 模板

```typescript
runOnce('<agent>-add-<plugin>-tools', () => {
  const row = db.prepare(
    "SELECT tools_list, user_tools_list FROM agents WHERE name = '<agent>'"
  ).get() as { tools_list: string | null; user_tools_list: string | null } | undefined;
  if (!row) return;

  const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
  const userList: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];
  let changed = false;

  // 要添加的工具名（从插件的 toolDefinitions 中获取）
  const newTools = ['tool_name_1', 'tool_name_2'];
  // 其中的写操作工具（需要限制普通成员调用）
  const writeTools = ['tool_name_1'];

  for (const t of newTools) {
    if (!list.includes(t)) { list.push(t); changed = true; }
  }
  for (const t of writeTools) {
    if (!userList.includes(t)) { userList.push(t); changed = true; }
  }

  if (changed) {
    db.prepare(
      "UPDATE agents SET tools_list = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = '<agent>'"
    ).run(JSON.stringify(list), userList.length > 0 ? JSON.stringify(userList) : null);
  }
});
```

### 实际示例：etf-monitor 绑定到 otcclaw 和 ticlaw

```typescript
runOnce('otcclaw-ticlaw-add-etf-monitor-tools', () => {
  const newTools = ['calc_etf_trades', 'query_etf_summary'];
  const writeTools = ['calc_etf_trades']; // 会写 DB，限制普通成员

  for (const agentName of ['otcclaw', 'ticlaw']) {
    const row = db.prepare(
      "SELECT tools_list, user_tools_list FROM agents WHERE name = ?"
    ).get(agentName) as { tools_list: string | null; user_tools_list: string | null } | undefined;
    if (!row) continue;

    const list: string[] = row.tools_list ? JSON.parse(row.tools_list) : [];
    const userList: string[] = row.user_tools_list ? JSON.parse(row.user_tools_list) : [];
    let changed = false;

    for (const t of newTools) {
      if (!list.includes(t)) { list.push(t); changed = true; }
    }
    for (const t of writeTools) {
      if (!userList.includes(t)) { userList.push(t); changed = true; }
    }

    if (changed) {
      db.prepare(
        "UPDATE agents SET tools_list = ?, user_tools_list = ?, updated_at = datetime('now') WHERE name = ?"
      ).run(JSON.stringify(list), userList.length > 0 ? JSON.stringify(userList) : null, agentName);
    }
  }
});
```

### 判断是否加 user_tools_list

- **写操作**（会修改数据库的工具）→ 加入 `user_tools_list` blocklist，仅 agent admin 可调用
- **纯只读**（查询/展示）→ 不加，普通成员也可用

## 3. 生效

两种方式任选：

- 重启服务：`npm run server`
- CLI 执行：`/reload_app`（热重载，无需重启）

### 验证

```sql
SELECT tools_list FROM agents WHERE name = 'otcclaw';
-- 确认 JSON 数组中包含新增的 tool name
```

## 4. 调试方式（不进 git）

适合开发阶段快速测试，直接用 CLI 修改 DB：

```
/agent otcclaw tools add calc_etf_trades,query_etf_summary
```

注意：此方式不写入代码，重新跑 migration 不会保留（但也不会被覆盖，除非有新 migration 重写 `tools_list`）。

## 5. Checklist

- [ ] 插件 `scope` 确认为 `agent-bound`
- [ ] `tools_list` migration 已添加到 `src/db/schema.ts`
- [ ] 写操作工具已加入 `user_tools_list` blocklist
- [ ] 重启/reload 后验证 SQL 结果正确
- [ ] agent admin 和普通成员各测试一次，确认权限符合预期

详细权限规范参见 `CLAUDE.md` 的「新增 Agent Tool 时的权限矩阵规范」章节。
