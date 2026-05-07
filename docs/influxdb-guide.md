# InfluxDB 交易数据库（v3.x）

场外极速交易数据和套保比例监控数据存储在 InfluxDB 3.x 中。

## 数据库连接


| 参数       | 值                                 |
| -------- | --------------------------------- |
| Host     | 175.178.64.67（环境变量 `INFLUX_HOST`） |
| Port     | 8181（环境变量 `INFLUX_PORT`）          |
| Database | otchk（环境变量 `INFLUX_DATABASE`）     |
| Token    | 环境变量 `INFLUX_TOKEN`（Bearer 认证）    |
| Timeout  | 60s（环境变量 `INFLUX_TIMEOUT`）        |


## 查询方式

InfluxDB 3.x 提供两种 HTTP 查询端点：

### 1. v3 原生 SQL 端点（推荐）

- **端点**: `POST /api/v3/query_sql`
- **认证**: `Authorization: Bearer <TOKEN>`
- **参数**: JSON body `{"db": "otchk", "q": "<SQL>", "format": "json"}`
- **优势**: 支持完整 SQL 语法（JOIN、聚合、窗口函数、类型转换等）

```python
import requests, json, os

INFLUX_HOST = os.environ.get('INFLUX_HOST', '175.178.64.67')
INFLUX_PORT = os.environ.get('INFLUX_PORT', '8181')
INFLUX_TOKEN = os.environ.get('INFLUX_TOKEN', '')
BASE_URL = f"http://{INFLUX_HOST}:{INFLUX_PORT}"

def query_sql(sql, db='otchk'):
    resp = requests.post(
        f"{BASE_URL}/api/v3/query_sql",
        headers={"Authorization": f"Bearer {INFLUX_TOKEN}"},
        json={"db": db, "q": sql, "format": "json"},
        timeout=60,
    )
    resp.raise_for_status()
    return resp.json()

rows = query_sql("SELECT * FROM north_info WHERE trade_dt = '20260507' LIMIT 10")
print(json.dumps(rows, indent=2, ensure_ascii=False))
```

### 2. v1 兼容 InfluxQL 端点

- **端点**: `GET /query?db=<DB>&q=<InfluxQL>`
- **认证**: `Authorization: Token <TOKEN>`
- **限制**: tag 字段仅支持 `=` 和 `=~`（正则），不支持 `>=` `<=`

```python
import requests, os
from urllib.parse import urlencode

INFLUX_HOST = os.environ.get('INFLUX_HOST', '175.178.64.67')
INFLUX_PORT = os.environ.get('INFLUX_PORT', '8181')
INFLUX_TOKEN = os.environ.get('INFLUX_TOKEN', '')
BASE_URL = f"http://{INFLUX_HOST}:{INFLUX_PORT}"

def query_influxql(influxql, db='otchk'):
    params = urlencode({"db": db, "q": influxql})
    resp = requests.get(
        f"{BASE_URL}/query?{params}",
        headers={"Authorization": f"Token {INFLUX_TOKEN}"},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    series = data.get("results", [{}])[0].get("series", [{}])[0]
    columns = series.get("columns", [])
    values = series.get("values", [])
    return [dict(zip(columns, row)) for row in values]

rows = query_influxql('SELECT * FROM "north_info" WHERE "trade_dt" = \'20260507\' LIMIT 10')
```

## Measurement 数据格式

### north_info — 北向极速成交数据

按交易对手/日期记录持仓和成交数据。

#### Tags（索引列，InfluxQL 中仅支持 = 和 =~ 过滤）


| 列名            | 类型     | 说明                                |
| ------------- | ------ | --------------------------------- |
| counter_party | string | 交易对手简称（如 WIZARD01, MINGSHIOPTIMA） |
| user_id       | string | 交易对手ID（同counter_party_ID）         |
| is_ft         | string | 是否极速交易（Y/N）                       |
| trade_dt      | string | 交易日期（格式 YYYYMMDD）                 |


#### Fields（数据列）


| 列名                  | 类型      | 说明                         |
| ------------------- | ------- | -------------------------- |
| pos_num             | integer | 持仓笔数                       |
| trade_num           | integer | 成交笔数                       |
| notional_t_1        | float   | T-1 日常速存续名义本金              |
| notional_ft_t_1     | float   | T-1 日极速多头存续名义本金            |
| notional_ft_short_t | float   | T 日极速空头名义本金                |
| trade_amt           | float   | T日常速成交金额                   |
| trade_amt_ft        | float   | T日极速多头成交金额                 |
| trade_amt_ft_short  | float   | T日极速空头成交金额                 |
| ft_net              | float   | T日极速多头净买入金额                |
| ft_net_short        | float   | T日极速空头净买入金额                |
| update_time         | string  | 更新时间（值为 "DELETED" 表示已删除记录） |


#### 业务含义

- **T 日极速存续名义本金** = `notional_ft_t_1 + ft_net`
- 过滤有效记录：`update_time != 'DELETED' AND trade_amt_ft > 0.01`
- 仅极速交易：`is_ft = 'Y'`

---

### hedge_ratio — 套保比例监控数据

QFII 对冲账户套保比例数据，由估值系统写入。

#### Tags（索引列）


| 列名             | 类型     | 说明                  |
| -------------- | ------ | ------------------- |
| product_id     | string | 产品 ID               |
| valuation_date | string | 估值日期（格式 YYYY-MM-DD） |


#### Fields（数据列）


| 列名                            | 类型      | 说明                 |
| ----------------------------- | ------- | ------------------ |
| product_name                  | string  | 产品名称               |
| valuation_file                | string  | 估值表文件名             |
| future_long_market_value      | float   | 股指期货多头市值           |
| future_short_market_value     | float   | 股指期货空头市值           |
| component_stocks_market_value | float   | 中证1800成分股市值        |
| hedge_ratio                   | float   | 套保比例               |
| updatetime                    | string  | 更新时间               |
| processed                     | integer | 是否已处理（0=未推送，1=已推送） |


#### 业务含义

- **套保比例** = 股指期货空头市值 / 中证1800成分股市值
- `processed = 0` 表示待推送的新数据

## 常用 SQL 查询参考

### 北向极速存续规模、成交金额（按日汇总，单位：亿）

```sql
SELECT 
  to_timestamp(trade_dt::STRING, '%Y%m%d') AS time, 
  sum(notional_ft_t_1 + ft_net) / 100000000.0 as notional, 
  sum(trade_amt_ft) / 100000000.0 as trade_amt 
FROM 
  north_info 
WHERE 
  is_ft = 'Y' AND
  update_time != 'DELETED' AND
  trade_amt_ft > 0.01
GROUP BY trade_dt ORDER BY trade_dt desc
```

### 查询某交易对手最近 N 日数据

```sql
SELECT trade_dt, counter_party, notional_ft_t_1, ft_net, trade_amt_ft
FROM north_info
WHERE counter_party = 'WIZARD01' AND is_ft = 'Y' AND update_time != 'DELETED' AND trade_amt_ft > 0.01
ORDER BY trade_dt DESC
LIMIT 30
```

### 查询最新套保比例

```sql
SELECT valuation_date, product_name, hedge_ratio, 
       future_short_market_value, future_long_market_value, 
       component_stocks_market_value
FROM hedge_ratio
ORDER BY time DESC
LIMIT 20
```

## 注意事项

1. **金额单位**: north_info 中金额均为元，展示时通常除以 1 亿转为亿元
2. **已删除记录**: `update_time = 'DELETED'` 的记录应排除
3. **有效数据过滤**: `trade_amt_ft > 0.01` 过滤无效零值记录
4. **InfluxQL tag 限制**: tag 列在 InfluxQL 中不支持 `>=`/`<=`，日期范围查询需用正则（`=~`）或改用 SQL 端点
5. **SQL 端点更灵活**: 推荐使用 `/api/v3/query_sql`，支持完整 SQL 语法
6. **数据量控制**: 查询时务必带 WHERE 条件或 LIMIT，避免全量扫描

