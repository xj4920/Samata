# Web 调用无结论问题改进

**日期**: 2026-05-06

## 问题

用户"请锐评一下中金公司"→ AI 先后尝试 cicc.com (HTTP 521)、bing.cn (超时)、baidu.com (验证码)、cn.bing.com (可用)，在必应上做了 6+ 次不同关键词搜索，30 轮预算耗尽仍未给出结论。

核心矛盾：现有循环检测只匹配"同工具+同参数"指纹，而 AI 每次换不同 URL 搜索时指纹全部不同，检测器认为一切正常。

## 改动

### 1. DevTools 工具预算上限 (`src/llm/agent.ts`)

- 新增 `MAX_DEVTOOLS_ROUNDS = 12` 常量
- agentic loop 中统计 `mcp_devtools_*` 调用次数
- 达到 12 次时 soft_warn（注入停止提示），超出时 hard_stop

### 2. 语义级循环检测 (`src/llm/agent.ts` `detectLoop`)

- 新增规则 4：滑窗内同一工具（不论参数）占比 >= 75% 时触发
- 捕获"不断用 navigate_page 打开不同 URL"的模式
- soft_warn/hard_stop 消息区分"参数相同"和"参数不同但方向重复"

### 3. web_fetch 失败引导 (`src/tools/web-tools.ts`)

- HTTP 403/503/521/522/523/525 时追加 `hint` 字段
- 引导 AI 不要通过浏览器工具重试同一站点

### 4. busy 页面检测 (`src/services/mcp-manager.ts`)

- `classifyInvalidDevtoolsResult` 新增 `RootWebArea busy` 模式匹配
- 识别为"页面仍在加载中"并返回错误 + 停止提示

### 5. 接入 DuckDuckGo 搜索 MCP (`config/mcp-servers.json`)

- 添加 `ddg-search` MCP server（`@oevortex/ddg_search@1.2.2`）
- 提供 `web-search` / `iask-search` / `monica-search` 三个工具
- 无需 API key，npx 直接运行
- AI 可通过 `mcp_ddg-search_web-search` 一次调用获取结构化搜索结果，替代手动操作浏览器搜索
