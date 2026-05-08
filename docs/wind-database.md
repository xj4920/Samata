# Wind 金融数据库（PostgreSQL）

基于 dataSync 项目从 Oracle Wind 数据库同步到本地 PostgreSQL 的数据。

## 数据库连接


| 参数       | 值                 |
| -------- | ----------------- |
| Host     | 127.0.0.1         |
| Port     | 5432              |
| Database | wind_sync         |
| 用户       | wind_sync（只读查询即可） |
| Python 库 | psycopg2          |


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


| 表名                             | 日期列      | 说明      |
| ------------------------------ | -------- | ------- |
| "ASHAREEODPRICES"              | TRADE_DT | A股日行情   |
| "AINDEXEODPRICES"              | TRADE_DT | 指数日行情   |
| "ASHAREEODDERIVATIVEINDICATOR" | TRADE_DT | A股日衍生指标 |
| "CINDEXFUTURESEODPRICES"       | TRADE_DT | 股指期货日行情 |


### 2. 财务报表（Financial Statements）


| 表名                   | 日期列    | 说明      |
| -------------------- | ------ | ------- |
| "ASHAREBALANCESHEET" | ANN_DT | A股资产负债表 |
| "ASHARECASHFLOW"     | ANN_DT | A股现金流量表 |
| "ASHAREINCOME"       | ANN_DT | A股利润表   |


### 3. 公司事件（Corporate Actions）


| 表名                        | 日期列              | 说明     |
| ------------------------- | ---------------- | ------ |
| "ASHAREDIVIDEND"          | ANN_DT           | A股分红   |
| "ASHARETRADINGSUSPENSION" | S_DQ_SUSPENDDATE | A股停复牌  |
| "ASHAREISACTIVITY"        | ANN_DT           | A股机构调研 |
| "ASHAREST"                | ENTRY_DT         | A股ST状态 |


### 4. 参考数据（Reference Data）


| 表名                     | 日期列        | 说明     |
| ---------------------- | ---------- | ------ |
| "ASHARECALENDAR"       | TRADE_DAYS | A股交易日历 |
| "ASHAREINDUSTRIESCODE" | OPDATE     | A股行业分类 |
| "ASHAREINTRODUCTION"   | ANN_DT     | A股公司简介 |


### 5. 一致预期与评级（Consensus & Ratings）


| 表名                        | 日期列       | 说明     |
| ------------------------- | --------- | ------ |
| "ASHARECONSENSUSDATA"     | EST_DT    | A股一致预期 |
| "ASHARESTOCKRATINGCONSUS" | RATING_DT | A股一致评级 |


### 6. 期货（Futures）


| 表名                        | 日期列             | 说明     |
| ------------------------- | --------------- | ------ |
| "CFUTURESCONTRACTMAPPING" | STARTDATE       | 期货合约映射 |
| "CFUTURESDESCRIPTION"     | S_INFO_LISTDATE | 期货合约信息 |


### 7. 基金（Mutual Fund）


| 表名                              | 日期列            | 说明     |
| ------------------------------- | -------------- | ------ |
| "CHINAMUTUALFUNDSTOCKPORTFOLIO" | ANN_DATE       | 基金持股明细 |
| "CHINAMUTUALFUNDDESCRIPTION"    | F_INFO_ANNDATE | 基金基本信息 |
| "CHINAMUTUALFUNDMANAGER"        | ANN_DATE       | 基金经理信息 |
| "CHINAMUTUALFUNDSECTOR"         | OPDATE         | 基金分类   |


### 8. 陆股通（Stock Connect）


| 表名                      | 日期列      | 说明       |
| ----------------------- | -------- | -------- |
| "SHSCCHANNELHOLDINGS"   | TRADE_DT | 陆股通持股明细  |
| "SHSCTOP10ACTIVESTOCKS" | TRADE_DT | 陆股通十大活跃股 |


## 完整列定义（写 SELECT 之前必读）

**全部 24 张表的字段定义（列名 / Oracle 原始类型 / 中文说明）已落到 `[docs/wind-tables-schema.md](wind-tables-schema.md)`。**

> **Oracle → PostgreSQL 类型映射**：schema 文件中显示的是 Oracle 原始类型，实际 PG 类型如下：
>
> - `VARCHAR2(8)` 日期列（TRADE_DT、ANN_DT、REPORT_PERIOD 等）→ PG **DATE**
> - `NUMBER(x,y)` → PG **NUMERIC**
> - `VARCHAR2(n)` 非日期列 → PG **VARCHAR**
> - `CLOB` → PG **TEXT**

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

**重要：** dataSync 同步时已将 Oracle VARCHAR2(8) 日期列（`TRADE_DT`、`ANN_DT`、`REPORT_PERIOD` 等）转为 PostgreSQL **DATE 类型**。查询时必须用 `YYYY-MM-DD` 格式或 DATE 表达式，不要用 `YYYYMMDD` 格式。

```python
# 近一年数据——直接用 DATE 运算，不要用 TO_CHAR
cur.execute('SELECT "S_INFO_WINDCODE", "TRADE_DT", "S_DQ_CLOSE" FROM "ASHAREEODPRICES" WHERE "S_INFO_WINDCODE" = %s AND "TRADE_DT" >= CURRENT_DATE - INTERVAL \'1 year\' ORDER BY "TRADE_DT"', (code,))

# 指定日期范围——用 YYYY-MM-DD 格式
cur.execute('SELECT * FROM "ASHAREEODPRICES" WHERE "TRADE_DT" >= %s AND "TRADE_DT" <= %s', ('2026-01-01', '2026-03-31'))
```

**筛选年报/季报（REPORT_PERIOD 是 DATE，禁止用 LIKE）：**

```python
# 取最近几个年报——直接用 DATE 列表
cur.execute('SELECT * FROM "ASHAREINCOME" WHERE "S_INFO_WINDCODE" = %s AND "REPORT_PERIOD" IN (%s, %s) AND "STATEMENT_TYPE" = %s', (code, '2024-12-31', '2025-12-31', '408001000'))

# 按月/日筛选——用 EXTRACT
cur.execute('SELECT * FROM "ASHAREINCOME" WHERE "S_INFO_WINDCODE" = %s AND EXTRACT(MONTH FROM "REPORT_PERIOD") = 12 AND EXTRACT(DAY FROM "REPORT_PERIOD") = 31 ORDER BY "REPORT_PERIOD" DESC LIMIT 5', (code,))
```

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
cur.execute('SELECT COUNT(*) FROM "ASHAREEODPRICES" WHERE "TRADE_DT" >= %s AND "TRADE_DT" < %s', ('2026-01-01', '2026-02-01'))
```

## 注意事项

1. **表名和列名必须用双引号**：PostgreSQL 默认将未加引号的标识符转为小写，而同步来的表名列名都是大写
2. **数据量极大**：部分表超千万行，务必带日期条件查询，严禁 `SELECT` * 无 WHERE
3. **OBJECT_ID 去重**：各表均有 OBJECT_ID 列，是记录的唯一标识
4. **TEXT 列**：Oracle 中的 CLOB 列在 PostgreSQL 中已转为 TEXT，可直接读取无需特殊处理
5. **数据来源**：数据由 dataSync 项目从 Oracle Wind 数据库同步而来，每日增量更新

## 常见陷阱与最佳实践

1. **列名拼写错误**：如 `TOT_SHHLDR_EQY_EXCL_MIN_INT` 少写了 R，正确为 `TOT_SHRHLDR_EQY_EXCL_MIN_INT`。遇到 `column "xxx" does not exist` 时，优先参考 PostgreSQL HINT 给出的建议列名，然后回 `docs/wind-tables-schema.md` 确认。
2. **列名不存在**：如 `S_VAL_PB` 在 ASHAREEODDERIVATIVEINDICATOR 表中不存在（只有 `S_VAL_PE`、`S_VAL_PS` 等）；`EST_YEAR` 在 ASHARECONSENSUSDATA 中不存在，正确为 `EST_REPORT_DT`。**写 SQL 前必须 `read_file docs/wind-tables-schema.md` 确认列名，禁止凭印象猜测。**
3. **估值指标返回 NULL**：部分表的最新日期可能尚未有数据（延迟更新），查到 NULL 时应先检查该表实际最新日期（`SELECT MAX("TRADE_DT") FROM "表名"`），或换用其他表获取。
4. **Wind 代码格式**：必须带市场后缀——深圳 `.SZ`（如 `000776.SZ`）、上海 `.SH`（如 `600000.SH`）、港股 `.HK`（如 `00700.HK`）。不带后缀会查不到数据。
5. **错误排查兜底**：列名不确定时，用 `information_schema.columns` 查表实际结构；数据为空时先查 `MIN/MAX` 确认数据范围：
  ```sql
   SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '表名';
   SELECT MIN("TRADE_DT"), MAX("TRADE_DT"), COUNT(*) FROM "表名" WHERE "S_INFO_WINDCODE" = 'xxx.SZ';
  ```
6. **避免 SELECT** ：数据量大、性能差，且无法及早发现列名错误。应明确指定所需列名。
7. **多表 JOIN 指定表别名**：`S_INFO_WINDCODE`、`TRADE_DT` 等列在多表都存在，JOIN 时必须用表别名限定（如 `a."TRADE_DT"`），否则报列名歧义错误。
8. **日期列是 DATE 类型，不要用 TO_CHAR 转文本再比较**：`TO_CHAR(CURRENT_DATE, 'YYYYMMDD')` 产生的文本 `'20250507'` 无法与 DATE 列比较。正确做法——直接用 DATE 运算：`"TRADE_DT" >= CURRENT_DATE - INTERVAL '1 year'`。
9. **禁止对 DATE 列使用 LIKE**：`"REPORT_PERIOD" LIKE '%1231'` 会报错（LIKE 只能用于文本类型）。筛选年报/季报用 `EXTRACT` 或直接比较日期值：`EXTRACT(MONTH FROM "REPORT_PERIOD") = 12 AND EXTRACT(DAY FROM "REPORT_PERIOD") = 31`，或 `"REPORT_PERIOD" IN ('2024-12-31', '2025-12-31')`。
10. **日期格式必须用 YYYY-MM-DD**：`'20260101'` 不是 PostgreSQL 能自动识别的日期格式，必须写成 `'2026-01-01'`。
11. **行业 / 同业对比不要误用 `ASHAREINDUSTRIESCODE`**：该表是**行业代码字典**（如 `INDUSTRIESCODE`、`INDUSTRIESNAME`），没有 `S_INFO_WINDCODE`，也没有 CSRC 行业代码列。不能与 `ASHAREEODDERIVATIVEINDICATOR` 按 `S_INFO_WINDCODE` 做 JOIN，否则会报列不存在或结果为空。按行业筛选股票需要 Wind 侧「证券–行业」映射表（若 dataSync 未同步到当前库，则本库可能不存在该表）。**写同业对比 SQL 前**用 `information_schema.columns` 确认实际存在的表与列；若仅有字典表，可改为手工列举可比证券 Wind 代码等可行替代方案。

## PostgreSQL 索引与查询形状（性能必读）

数据量在 wind_sync 中为 **千万级 / 亿级行**。执行慢几乎都是 **未命中复合索引**（并行 Seq Scan），与客户端超时无关。**每条 SELECT 必须按下列索引列顺序写过滤条件**，使优化器能走 `Index Scan` / `Bitmap Index Scan`，而不是只在单列日期索引上过滤后再丢掉绝大部分行。

DDL（运维执行一次；幂等）见 `[scripts/wind_sync_indexes.sql](../scripts/wind_sync_indexes.sql)`。执行后务必：`ANALYZE` 对应表。

### 已部署复合索引与对应写法


| 表                              | 复合索引列（顺序敏感）                                          | WHERE / ORDER BY 必须满足的写法                                                                                                                           |
| ------------------------------ | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ASHAREEODPRICES`              | `S_INFO_WINDCODE`, `TRADE_DT`                        | **先** `WHERE "S_INFO_WINDCODE" = %s`，再日期：`AND "TRADE_DT" >= ...`、`ORDER BY "TRADE_DT" DESC` / `ASC`。严禁单独 `WHERE "TRADE_DT" = 某日` 扫全市场。             |
| `ASHAREEODDERIVATIVEINDICATOR` | 同上                                                   | 同上；查最新估值同上（先 windcode，再按 `TRADE_DT` 排序取 LIMIT）。                                                                                                    |
| `ASHAREINCOME`                 | `S_INFO_WINDCODE`, `STATEMENT_TYPE`, `REPORT_PERIOD` | **先** `"S_INFO_WINDCODE" = %s` **且** `"STATEMENT_TYPE" = 408001000`（合并报表），再 `ORDER BY "REPORT_PERIOD" DESC`。缺 windcode 或缺 STATEMENT_TYPE 会导致大范围扫描。 |
| `ASHAREBALANCESHEET`           | 同上                                                   | 同上。                                                                                                                                                |
| `ASHARECONSENSUSDATA`          | `S_INFO_WINDCODE`, `EST_DT`                          | **先** `"S_INFO_WINDCODE" = %s`，再 `ORDER BY "EST_DT" DESC`。                                                                                         |


**索引前缀法则**：复合 btree 从第一列开始匹配；`WHERE` 里若没有 `**S_INFO_WINDCODE` 的等值条件**，通常无法用上述索引缩小到单只股票，容易 Seq Scan。

### 反模式（必然慢）

- 只用 `"TRADE_DT"` 或日期范围、不带 `"S_INFO_WINDCODE"`。
- `WHERE EXTRACT(MONTH FROM "REPORT_PERIOD") IN (...)` 作为主要过滤且没有前面的 windcode + STATEMENT_TYPE（必要时仍应先收紧 windcode）。
- `SELECT` * 且无缩小范围的 WHERE。

### 自检：是否命中索引

在沙箱里对大查询执行一次（示例）：

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT "TRADE_DT", "S_DQ_CLOSE" FROM "ASHAREEODPRICES"
WHERE "S_INFO_WINDCODE" = '000776.SZ' AND "TRADE_DT" >= CURRENT_DATE - INTERVAL '1 year'
ORDER BY "TRADE_DT" ASC;
```

期望计划中出现 `**Index Scan**` / `**Bitmap Index Scan**`，且索引名为 `idx_*wind_trade_dt` 或同类；若出现 `**Parallel Seq Scan**`，说明 WHERE 与索引列不一致或索引未创建/统计信息过期（尝试 `ANALYZE "表名"`）。

新建「证券–行业」映射表并同步数据后，为该表的 `S_INFO_WINDCODE`、行业代码等过滤列补充 btree 索引，并在 JOIN 条件中使用与索引一致的列。