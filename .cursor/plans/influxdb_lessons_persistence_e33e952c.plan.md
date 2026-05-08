---
name: InfluxDB lessons persistence
overview: 将 InfluxDB 查询经验教训固化到 agent 已有的知识链路中，确保 otcclaw 每次查 InfluxDB 时自动获取这些最佳实践。
todos:
  - id: fix-guide-examples
    content: 修复 docs/influxdb-guide.md 中的代码示例：token 校验 + 条件认证头 + 错误处理
    status: completed
  - id: add-pitfalls-section
    content: 在 docs/influxdb-guide.md 末尾新增"常见陷阱与最佳实践"节，覆盖 5 个教训
    status: completed
  - id: update-otcclaw-routing
    content: 微调 config/agents/otcclaw.md 第 93-99 行的 InfluxDB 路由指引，强化工具优先级
    status: completed
isProject: false
---

# InfluxDB 查询经验固化方案

## 问题分析

当前经验有三个可注入位置，各有优劣：


| 位置                                         | 注入时机                     | 问题                                    |
| ------------------------------------------ | ------------------------ | ------------------------------------- |
| `data/dreams/otcclaw.md` (dream)           | 每次对话 prompt 注入           | 每日被遥测数据覆盖重写；3000 字符上限；只反映"用过的工具"      |
| `config/agents/otcclaw.md` (static prompt) | 每次对话 prompt 注入           | 消耗固定 token 预算，不适合放详细技术细节              |
| `docs/influxdb-guide.md` (ref doc)         | agent 用 `read_file` 按需读取 | **当前最佳位置**：仅在查 InfluxDB 时才读，不浪费 token |


**结论：把经验写进 `docs/influxdb-guide.md`，这是 otcclaw 查 InfluxDB 前必读的文档。**

## 具体改动

### 1. 修复 `docs/influxdb-guide.md` 中的代码示例（消除反模式）

当前代码示例本身就包含用户踩到的坑，需要修正：

**a) v3 SQL 端点示例（第 28-48 行）** — 加入 token 校验 + 条件认证头：

```python
INFLUX_TOKEN = os.environ.get('INFLUX_TOKEN')

def query_sql(sql, db='otchk'):
    headers = {}
    if INFLUX_TOKEN:
        headers["Authorization"] = f"Bearer {INFLUX_TOKEN}"
    resp = requests.post(
        f"{BASE_URL}/api/v3/query_sql",
        headers=headers,
        json={"db": db, "q": sql, "format": "json"},
        timeout=60,
    )
    if resp.status_code != 200:
        print(f"Error {resp.status_code}: {resp.text[:500]}")
    resp.raise_for_status()
    return resp.json()
```

**b) v1 InfluxQL 端点示例（第 56-80 行）** — 同样修正 token 处理。

### 2. 在 `docs/influxdb-guide.md` 末尾新增"常见陷阱"节

在现有"注意事项"之后，追加一个 `## 常见陷阱与最佳实践` 节，覆盖用户列出的 5 个教训：

- **认证头**：`INFLUX_TOKEN` 为空时不要发 `Bearer`  空头，直接去掉 Authorization header
- **字段理解**：`notional_ft_t` 不是直接字段，需 `notional_ft_t_1 + ft_net` 计算；写 SQL 前必须确认 schema
- **工具选择顺序**：优先 `export_north_info_csv` / `query_trades` 等原生工具 + CSV 二次处理，sandbox 查 InfluxDB 是最后手段
- **环境变量校验**：sandbox 脚本必须在开头校验所有必需环境变量，缺失时立即报错而非静默空值
- **错误处理**：所有 HTTP 请求必须 `try-except`，打印 status_code 和 response body 前 500 字符

### 3. 微调 `config/agents/otcclaw.md` 的 InfluxDB 路由指引（第 93-99 行）

当前写法只有 3 步（read_file -> sandbox_write -> sandbox_exec），缺少"优先用原生工具"的强调和"读完文档后注意常见陷阱"的提示。改为：

```markdown
若用户需要查询 InfluxDB 中的北向交易数据或套保比例数据：

1. **优先尝试原生工具**：query_trades、trade_summary、export_north_info_csv、query_hedge_short —— 
   如果原生工具能满足需求（哪怕需要对 CSV 结果做二次聚合），就不要走 sandbox 路径
2. 只有原生工具确实无法满足时（如自定义聚合、跨日期范围统计），才走 sandbox 查询：
   a. 调用 `read_file` 读取 `docs/influxdb-guide.md`，**特别注意"常见陷阱"一节**
   b. 用 `sandbox_write_file` + `sandbox_exec` 执行 Python 脚本
```

## 不改动的部分

- **Dream 系统不改**：dream 的定位是"从遥测数据自动提炼经验"，这部分逻辑合理，不需要为了手写经验改架构
- **Memory 系统不改**：memory 适合存偏好和事实性记忆，不适合存详细技术文档

