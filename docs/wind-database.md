# Wind 金融数据库（PostgreSQL）

基于 dataSync 项目从 Oracle Wind 数据库同步到本地 PostgreSQL 的数据。

## 数据库连接

| 参数 | 值 |
|------|-----|
| Host | 127.0.0.1 |
| Port | 5432 |
| Database | wind_sync |
| 用户 | wind_sync（只读查询即可） |
| Python 库 | psycopg2 |

```python
import psycopg2

conn = psycopg2.connect(
    host="127.0.0.1",
    port=5432,
    dbname="wind_sync",
    user="wind_sync",
    password="wind_sync"
)
```

## 表一览（24 张，表名大写需加双引号）

**重要：** PostgreSQL 中表名使用双引号包裹的大写形式，如 `"ASHAREEODPRICES"`。不加引号会被转为小写导致找不到表。

### 1. 行情数据（Market Data）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "ASHAREEODPRICES" | TRADE_DT | A股日行情 |
| "AINDEXEODPRICES" | TRADE_DT | 指数日行情 |
| "ASHAREEODDERIVATIVEINDICATOR" | TRADE_DT | A股日衍生指标 |
| "CINDEXFUTURESEODPRICES" | TRADE_DT | 股指期货日行情 |

### 2. 财务报表（Financial Statements）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "ASHAREBALANCESHEET" | ANN_DT | A股资产负债表 |
| "ASHARECASHFLOW" | ANN_DT | A股现金流量表 |
| "ASHAREINCOME" | ANN_DT | A股利润表 |

### 3. 公司事件（Corporate Actions）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "ASHAREDIVIDEND" | ANN_DT | A股分红 |
| "ASHARETRADINGSUSPENSION" | S_DQ_SUSPENDDATE | A股停复牌 |
| "ASHAREISACTIVITY" | ANN_DT | A股机构调研 |
| "ASHAREST" | ENTRY_DT | A股ST状态 |

### 4. 参考数据（Reference Data）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "ASHARECALENDAR" | TRADE_DAYS | A股交易日历 |
| "ASHAREINDUSTRIESCODE" | OPDATE | A股行业分类 |
| "ASHAREINTRODUCTION" | ANN_DT | A股公司简介 |

### 5. 一致预期与评级（Consensus & Ratings）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "ASHARECONSENSUSDATA" | EST_DT | A股一致预期 |
| "ASHARESTOCKRATINGCONSUS" | RATING_DT | A股一致评级 |

### 6. 期货（Futures）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "CFUTURESCONTRACTMAPPING" | STARTDATE | 期货合约映射 |
| "CFUTURESDESCRIPTION" | S_INFO_LISTDATE | 期货合约信息 |

### 7. 基金（Mutual Fund）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "CHINAMUTUALFUNDSTOCKPORTFOLIO" | ANN_DATE | 基金持股明细 |
| "CHINAMUTUALFUNDDESCRIPTION" | F_INFO_ANNDATE | 基金基本信息 |
| "CHINAMUTUALFUNDMANAGER" | ANN_DATE | 基金经理信息 |
| "CHINAMUTUALFUNDSECTOR" | OPDATE | 基金分类 |

### 8. 陆股通（Stock Connect）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| "SHSCCHANNELHOLDINGS" | TRADE_DT | 陆股通持股明细 |
| "SHSCTOP10ACTIVESTOCKS" | TRADE_DT | 陆股通十大活跃股 |

## 完整列定义（写 SELECT 之前必读）

**全部 24 张表的字段定义（列名 / Oracle 原始类型 / 中文说明）已落到 [`docs/wind-tables-schema.md`](wind-tables-schema.md)。**

写任何查询前的硬性流程：

1. `read_file docs/wind-tables-schema.md` 拿到该表的字段列表。
2. 按列表里的真实列名拼 SELECT，不要凭印象猜测。
3. 列名在 PostgreSQL 中也是大写的（双引号包裹），如 `"S_INFO_WINDCODE"`。

## 常用查询模式

### 查表结构（兜底）

```sql
SELECT column_name, data_type
FROM information_schema.columns
WHERE table_name = 'ASHAREEODPRICES'
ORDER BY ordinal_position;
```

### 按日期范围查询

日期列在 PostgreSQL 中统一为 DATE 类型或 TEXT 类型（VARCHAR）：

**DATE 类型列：**
```python
sql = """
    SELECT "S_INFO_WINDCODE", "TRADE_DT", "S_DQ_CLOSE"
    FROM "ASHAREEODPRICES"
    WHERE "TRADE_DT" >= '2026-01-01'
    LIMIT 100
"""
```

**VARCHAR 类型日期列（格式 YYYYMMDD）：**
```python
sql = """
    SELECT "S_INFO_WINDCODE", "TRADE_DT", "S_DQ_CLOSE"
    FROM "ASHAREEODPRICES"
    WHERE "TRADE_DT" >= '20260101'
    LIMIT 100
"""
```

> 提示：dataSync 同步时将 Oracle VARCHAR2 日期列转为了 PG DATE 类型，查询时两种格式都可以尝试。

### 大数据量分批读取

```python
import psycopg2

conn = psycopg2.connect(
    host="127.0.0.1", port=5432,
    dbname="wind_sync", user="wind_sync", password="wind_sync"
)
cur = conn.cursor()
cur.execute(sql)

while True:
    rows = cur.fetchmany(10000)
    if not rows:
        break
    df = pd.DataFrame(rows, columns=[desc[0] for desc in cur.description])
    # 处理 df ...

cur.close()
conn.close()
```

### 按月统计

```python
sql = """
    SELECT COUNT(*)
    FROM "ASHAREEODPRICES"
    WHERE "TRADE_DT" >= '20260101' AND "TRADE_DT" < '20260201'
"""
```

## 注意事项

1. **表名和列名必须用双引号**：PostgreSQL 默认将未加引号的标识符转为小写，而同步来的表名列名都是大写
2. **数据量极大**：部分表超千万行，务必带日期条件查询，严禁 `SELECT *` 无 WHERE
3. **OBJECT_ID 去重**：各表均有 OBJECT_ID 列，是记录的唯一标识
4. **TEXT 列**：Oracle 中的 CLOB 列在 PostgreSQL 中已转为 TEXT，可直接读取无需特殊处理
5. **数据来源**：数据由 dataSync 项目从 Oracle Wind 数据库同步而来，每日增量更新
