# InfluxDB 查询指南

## 使用边界

北向极速成交、极速存续、极速总成交额已经迁移到 FastTrading summary 入库后的 PostgreSQL 查询：

- 普通极速查询使用 `query_trades`、`trade_summary`、`export_north_info_csv`
- 缺少当日数据时由管理员或系统定时任务使用 `sync_fast_trading_summary`
- 不再为了极速信息直接查询 InfluxDB `north_info`

常速成交、常速汇总、常速年化换手率使用 `query_normal_trading_summary` / `calc_normal_trading_annual_turnover`，不要用 `north_info` 的 `notional_t_1` / `trade_amt` 作为首选口径。

当前需要直接参考本文件的主要场景是：原生工具无法满足的套保比例 `hedge_ratio` 查询。

## 连接信息

| 项 | 值 |
|---|---|
| Host | `175.178.64.67`（环境变量 `INFLUX_HOST`） |
| Port | `8181`（环境变量 `INFLUX_PORT`） |
| Database | `otchk`（环境变量 `INFLUX_DATABASE`） |
| Token | 环境变量 `INFLUX_TOKEN` |
| Timeout | 60s（环境变量 `INFLUX_TIMEOUT`） |

## Python InfluxQL 示例

```python
import os
import requests

INFLUX_HOST = os.environ.get("INFLUX_HOST", "175.178.64.67")
INFLUX_PORT = os.environ.get("INFLUX_PORT", "8181")
INFLUX_DATABASE = os.environ.get("INFLUX_DATABASE", "otchk")
INFLUX_TOKEN = os.environ.get("INFLUX_TOKEN")
BASE_URL = f"http://{INFLUX_HOST}:{INFLUX_PORT}"

def query_influxql(influxql):
    headers = {"Accept": "application/json"}
    if INFLUX_TOKEN:
        headers["Authorization"] = f"Token {INFLUX_TOKEN}"
    resp = requests.get(
        f"{BASE_URL}/query",
        params={"db": INFLUX_DATABASE, "q": influxql},
        headers=headers,
        timeout=int(os.environ.get("INFLUX_TIMEOUT", "60")),
    )
    resp.raise_for_status()
    data = resp.json()
    result = data.get("results", [{}])[0]
    if result.get("error"):
        raise RuntimeError(result["error"])
    series = (result.get("series") or [{}])[0]
    cols = series.get("columns", [])
    return [dict(zip(cols, row)) for row in series.get("values", [])]

rows = query_influxql('SELECT * FROM "hedge_ratio" LIMIT 10')
print(rows[:3])
```

## 常见陷阱

1. `INFLUX_TOKEN` 为空时不要发送空的 `Authorization` header。
2. SQL 字符串用单引号包裹，避免 JSON 传输时破坏三引号。
3. 金额和比例字段的口径以原生工具返回为准；只有原生工具无法满足时才直接查库。
4. 极速成交不要再查 `north_info`；同步和查询都走 FastTrading summary / PostgreSQL。
