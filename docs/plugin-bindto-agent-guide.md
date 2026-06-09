# Plugin 绑定 Agent 操作指南

插件创建完成并被 Samata 加载后，如果其 `scope` 为 `agent-bound`，还需要将工具名显式加入目标 agent 的 `tools_list` 才能生效。

Agent 与工具绑定属于运行时配置，不再通过 `src/db/schema.ts` migration 写入平台代码。标准入口是管理员在 CLI/system-admin 语义下运行绑定脚本；脚本内部走现有 `saveAgent()` 权限与写库逻辑。

## 1. 前置条件确认

### 1.1 插件目录已配置

确认 `.env` 中 `SAMATA_PLUGINS_DIR` 包含插件所在父目录：

```env
SAMATA_PLUGINS_DIR=../samata-plugins,../samata-plugin-work,../samata-plugin-private
```

### 1.2 插件已成功加载

启动服务后日志应出现：

```text
Plugin [etf-monitor]: 2 tools loaded
```

若未出现，检查插件目录是否有 `index.ts` 且 `export default` 了合法的 `PluginModule`。

### 1.3 确认插件 scope

打开插件 `index.ts`，查看 `scope` 字段：

- `universal`：自动对所有 `standard` 模式 agent 可见，无需绑定。
- `agent-bound`：必须执行下面的绑定步骤。

## 2. 标准绑定方式

单次绑定：

```bash
npx tsx scripts/bind-agent-tools.ts \
  --agent otcclaw \
  --add calc_etf_trades,query_etf_summary \
  --member-block calc_etf_trades \
  --user admin
```

常用参数：

- `--add`：加入 `tools_list`，让 agent admin 可见。
- `--remove`：从 `tools_list` 移除。
- `--block`：加入 `block_tools`，agent admin 也不可见。
- `--unblock`：从 `block_tools` 移除。
- `--member-block`：加入 `user_tools_list`，并确保 `user_tools_mode='blocklist'`，用于限制普通成员。
- `--member-unblock`：从 `user_tools_list` 移除。
- `--dry-run`：只预览，不写 DB。
- `--json`：输出 JSON，方便自动化检查。

脚本是幂等的：重复执行不会重复追加工具，也不会在无变化时调用 `saveAgent()` 写库。

## 3. 批量绑定

批量配置文件放在本地忽略路径，例如 `config/agent-tool-bindings.local.json`：

```json
{
  "bindings": [
    {
      "agent": "otcclaw",
      "add": ["calc_etf_trades", "query_etf_summary"],
      "memberBlock": ["calc_etf_trades"]
    }
  ]
}
```

执行：

```bash
npx tsx scripts/bind-agent-tools.ts --config config/agent-tool-bindings.local.json --user admin
```

`config/agent-tool-bindings*.json` 已被 `.gitignore` 忽略，避免把私有 work 工具清单提交到 Samata 平台仓库。

## 4. 判断是否加入 member blocklist

- 写操作、同步、导入、删除、高成本刷新：加入 `--member-block`，仅 agent admin 可调用。
- 只读查询、计算只读结果：通常只放入 `--add`，普通成员可用。
- agent admin 也必须禁用的工具：加入 `--block`。

## 5. 验证

```bash
npx tsx scripts/bind-agent-tools.ts --agent otcclaw --add query_etf_summary --dry-run --json
npm run cli
```

在 CLI 中切换到目标 agent 后执行 `get_agent` 或 `/agent info`，确认可见工具符合预期。也可以只读查询 SQLite：

```sql
SELECT tools_list, block_tools, user_tools_mode, user_tools_list
FROM agents
WHERE name = 'otcclaw';
```

## Checklist

- [ ] 插件 `scope` 确认为 `agent-bound`。
- [ ] 工具名来自插件 `toolDefinitions`。
- [ ] 使用 `scripts/bind-agent-tools.ts` 完成绑定。
- [ ] 写操作工具已加入 `memberBlock`。
- [ ] agent admin 和普通成员各测试一次，确认权限符合预期。
