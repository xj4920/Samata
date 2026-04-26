# Oracle Wind 金融数据库

基于 dataSync 项目（Oracle → DolphinDB 数据同步系统）提取的 Oracle 数据库信息。

## 数据库连接

| 参数 | 值 |
|------|-----|
| Host | 10.2.89.132 |
| Port | 1521 |
| Service Name | winddb |
| 用户 | windquery（只读） |
| Python 库 | oracledb（推荐，无需 Oracle Client） |

```python
import oracledb

oracledb.init_oracle_client()
conn = oracledb.connect(
    user="windquery",
    password="wind2010query",
    dsn="10.2.89.132:1521/winddb"
)
```

数据库连接与查询代码见 `~/work/source/dataSync/` 项目，主要参考文件：
- `config/config.json` — 连接配置和表清单
- `sync/smart_sync.py` — 增量同步 + 校验（含 Oracle 查询示例）
- `sync/full_sync.py` — 全量同步（含日期类型判断、LOB 处理）
- `schema/create_tables.py` — 从 Oracle schema 创建目标库表

## 表一览（24 张，均属 WIND schema）

### 1. 行情数据（Market Data）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.ASHAREEODPRICES | TRADE_DT | A股日行情（约 1800 万行） |
| WIND.AINDEXEODPRICES | TRADE_DT | 指数日行情（约 2300 万行） |
| WIND.ASHAREEODDERIVATIVEINDICATOR | TRADE_DT | A股日衍生指标（约 2700 万行） |
| WIND.CINDEXFUTURESEODPRICES | TRADE_DT | 股指期货日行情 |

### 2. 财务报表（Financial Statements）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.ASHAREBALANCESHEET | ANN_DT | A股资产负债表 |
| WIND.ASHARECASHFLOW | ANN_DT | A股现金流量表 |
| WIND.ASHAREINCOME | ANN_DT | A股利润表（约 230 万行） |

### 3. 公司事件（Corporate Actions）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.ASHAREDIVIDEND | ANN_DT | A股分红 |
| WIND.ASHARETRADINGSUSPENSION | S_DQ_SUSPENDDATE | A股停复牌 |
| WIND.ASHAREISACTIVITY | ANN_DT | A股公司活动 |
| WIND.ASHAREST | ENTRY_DT | A股ST状态 |

### 4. 参考数据（Reference Data）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.ASHARECALENDAR | TRADE_DAYS | A股交易日历 |
| WIND.ASHAREINDUSTRIESCODE | OPDATE | A股行业分类 |
| WIND.ASHAREINTRODUCTION | ANN_DT | A股公司简介 |

### 5. 一致预期与评级（Consensus & Ratings）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.ASHARECONSENSUSDATA | EST_DT | A股一致预期（约 1170 万行） |
| WIND.ASHARESTOCKRATINGCONSUS | RATING_DT | A股一致评级（约 290 万行） |

### 6. 期货（Futures）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.CFUTURESCONTRACTMAPPING | STARTDATE | 期货合约映射 |
| WIND.CFUTURESDESCRIPTION | S_INFO_LISTDATE | 期货合约信息 |

### 7. 基金（Mutual Fund）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.CHINAMUTUALFUNDSTOCKPORTFOLIO | ANN_DATE | 基金持股明细（约 1650 万行） |
| WIND.CHINAMUTUALFUNDDESCRIPTION | F_INFO_ANNDATE | 基金基本信息 |
| WIND.CHINAMUTUALFUNDMANAGER | ANN_DATE | 基金经理信息 |
| WIND.CHINAMUTUALFUNDSECTOR | OPDATE | 基金分类 |

### 8. 陆股通（Stock Connect）

| 表名 | 日期列 | 说明 |
|------|--------|------|
| WIND.SHSCCHANNELHOLDINGS | TRADE_DT | 陆股通持股明细（约 700 万行） |
| WIND.SHSCTOP10ACTIVESTOCKS | TRADE_DT | 陆股通十大活跃股 |

## 常用查询模式

### 查表结构

```sql
SELECT column_name, data_type, data_length
FROM all_tab_columns
WHERE table_name = '<TABLE_NAME>' AND owner = 'WIND'
ORDER BY column_id
```

### 按日期范围查询

日期列可能是 VARCHAR2 或 DATE 类型，查询前需判断：

```python
def is_date_type_col(conn, table_name, col_name):
    """判断列是否为 DATE/TIMESTAMP 类型"""
    cur = conn.cursor()
    cur.execute(f"""
        SELECT data_type FROM all_tab_columns
        WHERE table_name = '{table_name.split(".")[-1].upper()}'
          AND column_name = '{col_name.upper()}'
          AND owner = '{table_name.split(".")[0]}'
    """)
    row = cur.fetchone()
    cur.close()
    if row:
        return 'DATE' in row[0].upper() or 'TIMESTAMP' in row[0].upper()
    return False
```

**DATE 类型列：**
```python
import datetime
dt = datetime.datetime.strptime("20260101", "%Y%m%d").strftime("%Y-%m-%d")
sql = f"SELECT * FROM WIND.ASHAREEODPRICES WHERE TRADE_DT >= to_date('{dt}', 'yyyy-mm-dd')"
```

**VARCHAR2 类型列（大多数情况）：**
```python
sql = f"SELECT * FROM WIND.ASHAREEODPRICES WHERE TRADE_DT >= '20260101'"
```

### 大数据量分批读取

```python
cursor = conn.cursor()
cursor.prefetchrows = 10000
cursor.arraysize = 10000
cursor.execute(sql)

while True:
    rows = cursor.fetchmany()
    if not rows:
        break
    df = pd.DataFrame(rows, columns=header)
    # 处理 df ...
cursor.close()
```

### 按月统计

```python
sql = f"""
    SELECT COUNT(*)
    FROM WIND.ASHAREEODPRICES
    WHERE TRADE_DT >= '20260101' AND TRADE_DT < '20260201'
"""
```

## 特殊列处理

### LOB 列（需要 .read() 读取）

| 列名 | 所属表 |
|------|--------|
| INVESTSTRATEGY | CHINAMUTUALFUNDDESCRIPTION |
| RISK_RETURN | CHINAMUTUALFUNDDESCRIPTION |
| F_INFO_MANAGER_RESUME | CHINAMUTUALFUNDMANAGER |
| REPORT_SUMMARY | ASHARESTOCKRATINGCONSUS |
| S_INFO_CHINESEINTRODUCTION | ASHAREINTRODUCTION |
| S_INFO_MAIN_BUSINESS | ASHAREINTRODUCTION |
| S_INFO_BUSINESSSCOPE | ASHAREINTRODUCTION |
| F_INFO_INVESTSCOPE | CHINAMUTUALFUNDDESCRIPTION |
| F_INFO_INVESTCONCEPTION | CHINAMUTUALFUNDDESCRIPTION |
| F_INFO_DECISION_BASIS | CHINAMUTUALFUNDDESCRIPTION |
| MARKET_RISK | CHINAMUTUALFUNDDESCRIPTION |
| F_INFO_FLOATINGMGNTFEEDESCRIP | CHINAMUTUALFUNDDESCRIPTION |

```python
def read_lob(cell):
    if cell is None:
        return ""
    if hasattr(cell, 'read'):
        return cell.read()
    return cell
```

### 忽略列

dataSync 中忽略的列（同步时不使用）：`S_DIV_CHANGE`, `S_FELLOW_OBJECTIVE`, `CHINESEDEFINITION`

## 数据量级参考

| 表 | Oracle 约行数（2026.03） |
|----|------------------------|
| AINDEXEODPRICES | 23,729,811 |
| ASHAREEODDERIVATIVEINDICATOR | 27,158,170 |
| ASHAREEODPRICES | 18,033,779 |
| CHINAMUTUALFUNDSTOCKPORTFOLIO | 16,517,968 |
| ASHARECONSENSUSDATA | 11,700,971 |
| SHSCCHANNELHOLDINGS | 7,025,751 |
| ASHAREINCOME | 2,325,524 |
| ASHARESTOCKRATINGCONSUS | 2,916,184 |
| CHINAMUTUALFUNDSECTOR | 939,140 |
| ASHAREBALANCESHEET | 838,478 |
| ASHARETRADINGSUSPENSION | 567,313 |

## 注意事项

1. **只读权限**：windquery 用户只有查询权限，不能写数据
2. **数据量极大**：部分表超千万行，务必带日期条件分批查询，严禁 `SELECT *` 无 WHERE
3. **日期列类型不统一**：有的表日期列是 DATE，有的是 VARCHAR2，查询前必须判断类型
4. **OBJECT_ID 去重**：各表均有 OBJECT_ID 列，是记录的唯一标识
5. **代码参考**：完整的数据同步、查询、Schema 获取代码见 `~/work/source/dataSync/` 项目
6. **同步目标**：数据同步至 DolphinDB (`175.178.64.67:8848`) 或 PostgreSQL (`10.8.0.1:5432`)，已有同步管线每日运行
