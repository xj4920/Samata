# 近两周功能更新摘要（04/09–04/23）

## 1. 文档导入知识库

新增 `import_document` 工具，支持将 .md / .docx / .xlsx / .csv / .pdf 文件导入为结构化知识。流程：插件层解析文件 → LLM 按章节切分 + 提取 tags → 存储为 Markdown 文件 + ripgrep 搜索（替代旧 DB chunk 方案）。导入过程实时输出进度，支持带图片的文档。权限上 `import_document` / `delete_document` 已加入每个 agent 的 user blocklist，普通成员不可调用。

## 2. 流程/架构图生成

新增 `diagram` 插件，基于 Mermaid DSL 生成流程图、时序图、ER 图、甘特图、思维导图、C4 架构图等，渲染为 PNG 图片后通过 `send_image` 发送给用户。支持 flowchart / sequenceDiagram / classDiagram / erDiagram / gantt / pie / mindmap / stateDiagram-v2 / gitgraph / C4 等图表类型。

## 3. 网页检索

从 Playwright MCP 切换到 Chrome DevTools MCP，browser preset 覆盖 28 个 DevTools 工具（导航、截图、快照、点击/填写、JS 执行、Console/Network 监控、Lighthouse 审计、性能追踪、内存快照、设备模拟等）。otcclaw agent prompt 添加了浏览器使用指引：navigate → snapshot → 提取信息。standard 模式 agent 自动包含 MCP 工具。

## 4. 报价信息导入

新增两个报价导入工具：
- `import_pricing_schedule`：导入客户佣金/融资成本条款报价（Pricing Schedule Excel），支持 dry_run 预览 → 确认后写入，自动匹配 customers.json 管理人映射
- `import_pricing_quote`：导入产品利率矩阵（FXD/FRN Daily Update），解析 Fixed/Floating × Currency × Tenor 报价写入 pricing_quotes 表

两类报价语义严格区分：条款表 → pricing_schedule，利率矩阵 → pricing_quote。查询端同步新增 `query_pricing_quote` / `list_pricing_quote_dates`。

## 5. LLM 从 MiniMax 切换到 GLM 5.1

新增 GLM provider（`src/llm/glm.ts`），使用 OpenAI 协议兼容 API，默认模型 `external-glm-5-turbo`，视觉模型 `external-glm-4.5v`。per-agent provider 路由机制允许不同 agent 使用不同 provider（otcclaw/admin 用 Claude，其他 agent 用 GLM）。`getModelForTask` fallback 改用 task provider 的 defaultModel，避免跨 provider 不匹配。

## 6. 交易日历计算

新增 `calculate_date` 工具，加载 SSE 交易日历（`config/trading-calendar-sse.json`，覆盖 2005–2026），支持：判断是否为交易日、计算 N 个交易日后的日期、获取最近交易日、交易日区间统计。system prompt 通过 `{{datetime}}` 注入当前日期时间，agent 有了时间感知能力。