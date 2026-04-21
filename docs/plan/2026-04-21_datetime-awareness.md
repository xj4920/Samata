# 日期时间感知增强计划

## Context

当前 GLM 模型对日期时间理解很差，导致到期日推算错误（如把今天+2月算成6月20日周六，而非6月19日周五交易日）。两路并行：

- **A. Ambient Context**：在 system prompt 尾部注入 `{{datetime}}`（日 + 星期 + 交易日状态），解决"今天几号/是不是交易日"这类追问。
- **B. Precise Computation**：新增 `calculate_date` 工具，让确定性代码做日期加减、交易日推算。

### 关键设计取舍（与旧版方案的差异）

1. **交易日历数据源用本地 JSON，不连 PG**。dataSync 项目已将 Wind `ASHARECALENDAR` 同步到 PostgreSQL（`wind_sync` 库，SSE 12263 条至 2040 年）。**不直连**：otcclaw 只有 SQLite，为一个日期工具拉起 PG 客户端 + 网络依赖 + 连接池代价过大；且企微/飞书 bot 运行环境未必同网段。改用一次性 dump 脚本 → `config/trading-calendar-sse.json`，服务启动时加载进内存 Set，O(1) 查询、零运行时依赖。
2. **`{{datetime}}` 放在模板末尾**，不放开头。放开头会让动态内容前置，破坏 prompt cache 的静态前缀；模型从尾部读到同样能理解。
3. **prompt 里的 datetime 只到"日 + 星期 + 交易日状态"**，不到分钟/秒。长对话里分钟级时间会过时误导模型；精确时间由 `calculate_date` 的 `now` operation 现场查。
4. **精简 9 个 op 到 4 个**（shift / diff / is_trading_day / now），避免模型在分支选择上犯错。
5. **绝不 fallback 到"纯周末检测"**。中国节假日由国务院通知决定（春节/国庆 7 天、五一、清明等 + 调休），周末检测必定给错误答案。交易日历加载失败时工具直接返回 error，由 LLM 告知用户，宁可报错不可误导。
6. **期权到期日不做通用工具操作**。中国场内期权（50ETF/300ETF 第四个周三、股指期权第三个周五、场外按约定）算法不同，混到一个 `add_months(skip_non_trading)` 会错。工具只提供"加 N 月后顺延到下一交易日"（适合场外），场内期权到期日另做 skill 或在 prompt 里规避。

## Part A: System Prompt 注入 `{{datetime}}`

### A1: `buildDateTimeBlock()` — `src/llm/agents/prompt.ts`

在 `buildSystemPrompt()` 的 `vars` map 中新增 `datetime` key。输出形如：

```
📅 今天：2026-04-21 星期二（A股交易日）
```

实现要点：
- 使用 `dayjs` + `Asia/Shanghai` 固定时区（`dayjs/plugin/timezone` + `utc`）。
- 调用 `isChineseTradingDay(today)` 判断交易日状态（交易日 / 周末 / 法定假日 / 调休上班）。
- **只到日级粒度**，不含分钟秒，避免长对话中过时。精确时间走 `calculate_date.now`。
- 现有 `renderPrompt` 的 regex `\{\{([\w.]+)\}\}` 已支持 `datetime` key，无需修改。

### A2: 8 个 agent 模板在**末尾**追加 `{{datetime}}`

文件：`config/agents/{_default,otcclaw,tutor,doctor,alter-ego,admin,potato,man}.md`

在模板**末尾**（`{{memory}}` 之后）追加一行 `{{datetime}}`。保持静态前缀不变，让 prompt cache 尽可能命中。

### A3: 清理 `src/llm/agent.ts::getSystemPrompt()` 硬编码 prompt

`CLAUDE.md` 明确规定"禁止把 prompt 硬编码到 TS 代码里"。本次顺带清理：

- `runAgenticChat` 中 `agent ? buildSystemPrompt(agent, user) : getSystemPrompt(user)` 的 fallback 分支基本不会走（`getDefaultAgent()` 永远返回 agent），直接删除 `getSystemPrompt()` 或让它也走 `buildSystemPrompt(getDefaultAgent(), user)`。
- 避免在死代码上打补丁。

## Part B: `calculate_date` 工具

### B0: 一次性同步脚本 — `scripts/sync-trading-calendar.ts`（新文件）

从 dataSync 的 PG 中 dump SSE 交易日到本地 JSON：

- 连接参数：直接读 dataSync 项目的配置，或命令行参数传入（本脚本只在管理员工作站执行，不进服务运行时）。
- SQL：`SELECT "TRADE_DAYS" FROM "ASHARECALENDAR" WHERE "S_INFO_EXCHMARKET"='SSE' ORDER BY "TRADE_DAYS"`
- 输出：`config/trading-calendar-sse.json`，格式 `{ "exchange": "SSE", "generated_at": "...", "days": ["2020-01-02", "2020-01-03", ...] }`（~200 KB）。
- 频率：每季度手动跑一次（或 CI cron），数据每年只追加几百条，不需要实时。

### B1: 核心逻辑 — `src/commands/date.ts`（新文件）

导出：
- `loadTradingCalendar()` — 启动时读 JSON 进内存 `Set<string>`（懒初始化）。日历缺失时 throw，由 tool handler 转 error。
- `isChineseTradingDay(date)` — O(1) Set 查询。
- `getNextTradingDay(date)` / `getPreviousTradingDay(date)` — 从给定日期起迭代查 Set。
- `getTradingDaysBetween(start, end)` — 返回两端交易日数组。
- `calculateDate(operation, params)` — 主入口，dispatch 到下列 4 个 op。

支持 **4 种 operation**（从 9 个精简）：

| Operation | 参数 | 返回 | 说明 |
|-----------|------|------|------|
| `shift` | `date, days?, months?, years?, skip_non_trading?` | 新日期 + weekday + is_trading_day | 通用平移。负数表示减。`skip_non_trading=true` 时遇非交易日顺延到下一交易日。覆盖旧方案的 add_days / subtract_days / add_months / next_trading_day / previous_trading_day。 |
| `diff` | `start_date, end_date` | `{ calendar_days, trading_days }` | 同时返回自然日差和交易日差，一次返回不必两次调用。 |
| `is_trading_day` | `date` | `{ is_trading_day, weekday, reason? }` | 布尔查询，非交易日时附原因（weekend / holiday / historical data end）。 |
| `now` | `tz?`（默认 `Asia/Shanghai`） | `{ datetime_iso, date, time, weekday, is_trading_day }` | 返回当前时间（精确到秒），替代在 prompt 中硬塞分钟级时间。 |

**去掉的 op 及理由**：
- `calendar_days_between` → 并入 `diff`。
- `format_date` → 模型拿到结构化输出自己格式化即可，没必要做工具。
- `next_trading_day` / `previous_trading_day` → 用 `shift(days=±1, skip_non_trading=true)` 表达。
- `add_months` / `add_days` / `subtract_days` → 合并为 `shift`。

**时区**：所有日期 input/output 默认 `Asia/Shanghai`，在 tool description 里显式声明。

### B2: Tool 模块 — `src/tools/date-tools.ts`（新文件）

遵循现有模式：导出 `toolDefinitions` + `handleTool`，薄包装调用 `src/commands/date.ts`。

Tool description 要点（写进 prompt 供模型参考）：
- 明确"`shift` 的 `skip_non_trading` 适用于**场外期权按自然日加 N 月后顺延到下一交易日**；场内 ETF 期权（第四个周三）/ 股指期权（第三个周五）到期日**不要用本工具**，请告知用户具体规则后人工确认"。
- 明确时区 `Asia/Shanghai`，输入输出日期一律 `YYYY-MM-DD`。

### B3: 类型定义 — `src/llm/tool-types.ts`

新增 `CalculateDateInput` 类型（discriminated union by `operation`）。

## Part C: 注册 & COMMON_SET

### C1: `src/tools/index.ts`

import `dateTools` 加入 `modules` 数组。

### C2: `src/llm/agents/config.ts`

`COMMON_SET` 新增 `'calculate_date'`（只读工具，**不**加 user blocklist，普通成员也能用）。

## Part D: 依赖

- `dayjs` + `dayjs/plugin/utc` + `dayjs/plugin/timezone`（已安装 dayjs，插件随包自带，无需新增依赖）。
- **不再需要 `pg`**，所有运行时只读本地 JSON。
- `scripts/sync-trading-calendar.ts` 临时使用 `pg`，可通过 `npm install --save-dev pg` 装在 devDependencies，不污染生产依赖。

## 实施顺序

1. 写 `scripts/sync-trading-calendar.ts`，从 PG dump SSE 交易日到 `config/trading-calendar-sse.json`；手动跑一次，提交 JSON 进 git。
2. 创建 `src/commands/date.ts`（加载 JSON + 4 个 op 核心逻辑 + `isChineseTradingDay` 导出）。
3. 创建 `src/tools/date-tools.ts`（tool wrapper，description 明确时区/场内期权免责）。
4. `src/llm/tool-types.ts` 添加 `CalculateDateInput`。
5. `src/tools/index.ts` import `dateTools`。
6. `src/llm/agents/config.ts` `COMMON_SET` 加入 `'calculate_date'`。
7. `src/llm/agents/prompt.ts` 新增 `buildDateTimeBlock()` + `datetime` vars key（只到日 + 星期 + 交易日状态）。
8. 8 个 `config/agents/*.md` **末尾**追加 `{{datetime}}`。
9. 清理 `src/llm/agent.ts::getSystemPrompt()` 硬编码 fallback，改走 `buildSystemPrompt(getDefaultAgent(), user)` 或直接删除未使用分支。

## 验证方法

### 功能跑通
1. `/reload_app` 或重启。
2. `get_status_summary` 确认工具注册成功。
3. CLI 中调用 `calculate_date { operation: "now" }`，确认返回当前时间 + 交易日状态。
4. 检查 system prompt 尾部是否包含 datetime block（开 debug log）。

### 数据正确性（关键，避免节假日误判）
5. **春节假期**：`is_trading_day { date: "2026-02-17" }` → false；`shift { date: "2026-02-17", days: -1, skip_non_trading: true }` → `2026-02-13`（2-14 周六、2-15 周日、2-16~23 春节）。
6. **国庆长假**：`is_trading_day { date: "2026-10-01" }` → false；`shift { date: "2026-10-01", days: 1, skip_non_trading: true }` → `2026-10-09`。
7. **调休上班**：若日历中某周六是调休交易日，`is_trading_day { date: "..." }` → true。
8. **跨年 + 月底**：`shift { date: "2025-12-31", months: 2 }` → `2026-02-28`（非 02-31）；若顺延则到下一交易日。
9. **闰年**：`shift { date: "2024-02-29", years: 1 }` 约定为 `2025-02-28`（在代码注释 + tool description 里声明）。
10. **边界**：查询 2041 年后的日期 → 返回 error "交易日历数据仅覆盖至 2040 年"，不 fallback 周末检测。

### 集成场景
11. 企微/CLI 问"2个月后的场外期权到期日是什么"，验证模型调用 `calculate_date { operation: "shift", months: 2, skip_non_trading: true }`，并在回答里提及"此为场外规则，场内期权请确认具体条款"。
12. 长对话测试：10 轮对话后追问"现在几点了" → 模型调用 `calculate_date { operation: "now" }` 而非依赖 prompt 里的固定日期（prompt 里本来也没有分钟级时间）。
