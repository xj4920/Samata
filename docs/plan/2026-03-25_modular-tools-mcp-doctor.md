---
docModules:
  - plugins
docTopics:
  plugins: Tool / Skill / MCP
canonicalDocs:
  - /plugins/sdk-and-lifecycle
status: implemented
---

# Samata 新功能扩展设计方案

## Context

用户希望为 Samata 添加两类新功能：
1. **Chrome DevTools / 浏览器自动化** — 以 MCP Server 方式接入
2. **家庭医生增强** — 专业知识库 + 健康数据管理 + 用药提醒 + 更强系统提示词

**新增核心问题**：是否把所有现有 tools 也改成 MCP 调用，彻底解决 `agent.ts` 臃肿问题？

---

## 架构选型：内部工具如何管理

### 现状问题

`src/llm/agent.ts` 当前 1500+ 行，工具定义 + handler 全混在一起，越来越难维护。

### 三种选项对比

| 方案 | 描述 | 优点 | 缺点 |
|------|------|------|------|
| **A. 全量 MCP** | 所有工具都变成独立 MCP Server | 标准协议，极度解耦 | 多进程 IPC 开销，运维复杂，启动慢 |
| **B. 工具模块化** | 按领域拆分为 `src/tools/` 下的 TS 模块 | 零 IPC，结构清晰，改造成本低 | 仍是单进程，不跨项目复用 |
| **C. 混合（推荐）** | 内部工具模块化，外部能力用 MCP | 内外职责清晰，无冗余开销 | 有两套接入方式需维护 |

### 推荐：方案 C（混合架构）

**判断依据**：
- Samata 的内部工具（客户、交易、知识库等）全部访问同一个 SQLite 数据库，进程隔离无实质意义
- 浏览器自动化、外部 API 等天然需要独立进程（沙箱、生命周期管理）
- 方案 C 解决了臃肿问题，同时不引入不必要的 IPC 复杂度

---

## Part 1：内部工具模块化重构（解决臃肿）

将 `agent.ts` 按领域拆分，`agent.ts` 本身退化为聚合器。

### 目录结构

```
src/tools/                        # 新建，按领域组织
├── index.ts                      # 聚合所有工具，导出 getAllNativeTools()
├── client-tools.ts               # 客户管理 (6 tools)
├── trade-tools.ts                # 交易数据 (4 tools)
├── knowledge-tools.ts            # 知识库 (6 tools)
├── skill-tools.ts                # Skill 管理 (4 tools)
├── agent-tools.ts                # Agent 管理 (8 tools)
├── memory-tools.ts               # 记忆 (4 tools)
├── file-tools.ts                 # 文件 I/O (6 tools)
├── wework-tools.ts               # 企微 (1 tool)
├── reminder-tools.ts             # 提醒 (3 tools)
├── health-tools.ts               # 健康数据（新增, 4 tools）
└── system-tools.ts               # 系统状态 (2 tools)
```

每个文件导出：
```typescript
export const toolDefinitions: Anthropic.Tool[] = [...]
export async function handleTool(name: string, input: any, ctx?: DeliveryContext): Promise<string | null>
// 返回 null 表示该工具不属于本模块
```

`src/tools/index.ts`：
```typescript
import * as clientTools from './client-tools.js';
// ...
const modules = [clientTools, tradeTools, ...];

export function getAllNativeTools(): Anthropic.Tool[] {
  return modules.flatMap(m => m.toolDefinitions);
}

export async function executeNativeTool(name, input, ctx): Promise<string> {
  for (const m of modules) {
    const result = await m.handleTool(name, input, ctx);
    if (result !== null) return result;
  }
  throw new Error(`Unknown tool: ${name}`);
}
```

### 修改 agent.ts

- 删除所有工具定义（~1200 行）
- `getGlobalTools()` → `getAllNativeTools()` + MCP 工具合并
- `executeTool()` → 先尝试 `executeNativeTool()`，再尝试 MCP

重构后 `agent.ts` 预期 **缩减到 200~300 行**，聚焦在 agentic loop 逻辑。

---

## Part 2：MCP 客户端框架（外部能力接入）

让 Samata 应用本身能动态加载外部 MCP 服务器。

### 新增文件

**`config/mcp-servers.json`**
```json
{
  "servers": {
    "browser": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless"],
      "description": "浏览器自动化"
    }
  }
}
```

**`src/services/mcp-manager.ts`**
- `initMcpServers()` — 应用启动时连接所有配置的 MCP 服务器
- `getMcpTools()` — 返回 `Anthropic.Tool[]` 格式
- `callMcpTool(serverName, toolName, input)` — 转发调用
- `stopMcpServers()` — 优雅关闭

MCP 工具命名规范：`mcp_<server>_<toolname>`（避免与 native 工具冲突）。

---

## Part 3：浏览器 MCP Agent

**技术选型说明**：Playwright 封装了 Chrome DevTools Protocol（CDP），`@playwright/mcp` 是微软官方基于 Playwright 的 MCP Server，二者是上下层关系，只需接入 `@playwright/mcp` 即可，无需单独集成 CDP。

安装 `@playwright/mcp`，配置后自动暴露工具：
- `mcp_browser_navigate`, `mcp_browser_screenshot`
- `mcp_browser_click`, `mcp_browser_type`
- `mcp_browser_evaluate`, `mcp_browser_get_content`

**`src/llm/agents/config.ts`**：新增 `browser` TOOL_PRESET（枚举上述工具名）

**`src/db/schema.ts`**：新增 browser agent seed：
```typescript
ins.run('agent-browser', 'browser', '浏览器助手', '网页浏览、截图、内容提取', 'allowlist', browserTools, 'admin-001');
```

---

## Part 4：家庭医生增强

### 4.1 健康数据管理

**`src/db/schema.ts`** — 新增 migration：
```sql
CREATE TABLE IF NOT EXISTS health_records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  record_type TEXT NOT NULL,   -- 'blood_pressure'|'blood_sugar'|'weight'|'custom'
  value TEXT NOT NULL,         -- JSON 或纯数值
  unit TEXT,
  measured_at TEXT NOT NULL,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**`src/tools/health-tools.ts`**（对应 `src/commands/health.ts` 中的业务函数）：
- `add_health_record` — 记录指标数据
- `query_health_records` — 查询历史（支持类型/时间范围筛选）
- `health_summary` — 各指标最近3次 + 趋势
- `set_medication_reminder` — 包装 reminder，支持"每天X时"周期语法
- `archive_health_file` — 将用户上传的图片存档到健康文件目录，写入元数据
- `list_health_files` — 按 doc_type / 时间范围查询存档列表
- `view_health_file` — 取文件路径供 agent 重新加载图片（用于历史对比分析）

**图片存档设计**：

```
存储结构（文件系统）
$HEALTH_FILES_DIR/<user_id>/<YYYY-MM>/<timestamp>_<filename>

默认路径: ~/Documents/my/XBase/health
配置方式: 环境变量 HEALTH_FILES_DIR（用户可自定义）

元数据（DB 新表 health_files）
id, user_id, agent_id, file_path, doc_type, measured_at, notes, created_at
doc_type: 'blood_test' | 'imaging' | 'prescription' | 'report' | 'other'
```

**典型流程**：
1. 用户发送图片 → agent 做 vision 分析
2. 分析后调用 `archive_health_file`，复制到存档目录，写元数据
3. 下次"与上次对比"→ `list_health_files` 取记录 → `view_health_file` 重载图片 → 对比分析

### 4.2 系统提示词 + 知识库

通过 migration 更新 doctor 的 `system_prompt`：结构化回答格式、明确免责边界。

预置医学 FAQ migration：常见症状鉴别、用药注意事项、慢性病指标参考值。

---

## 实施顺序

```
阶段1（先做，独立）: 内部工具模块化重构
  └─ src/tools/ 目录结构 → agent.ts 瘦身

阶段2（依赖阶段1）: 家庭医生增强
  └─ health_records migration → health-tools.ts → doctor prompt

阶段3（相对独立）: MCP 框架 + 浏览器工具
  └─ mcp-manager.ts → getGlobalTools 扩展 → browser agent seed
```

---

## 关键文件清单

| 动作 | 文件 |
|------|------|
| **新建目录** | `src/tools/` (12个文件) |
| 新建 | `src/services/mcp-manager.ts` |
| 新建 | `src/commands/health.ts` |
| 新建 | `config/mcp-servers.json` |
| **大改** | `src/llm/agent.ts` — 删除工具定义，改为聚合调用，预期缩到 ~300 行 |
| 修改 | `src/llm/agents/config.ts` — 新增 browser TOOL_PRESET |
| 修改 | `src/db/schema.ts` — health_records migration + doctor prompt migration + browser agent seed |

---

## 验证方式

1. **重构验证**：重构后所有现有工具行为不变，`venv/bin/python` 运行单元测试 / 手动 CLI 回归
2. **家庭医生**：切换 doctor agent → 记录血压 → 查趋势 → 设置用药提醒
3. **浏览器工具**：切换 browser agent → 截图网页 → 提取正文
4. **权限验证**：非 doctor agent 无法调用健康工具
