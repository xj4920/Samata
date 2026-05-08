## CINDEXFUTURESEODPRICES

**Oracle 表名：** WIND.CINDEXFUTURESEODPRICES

**字段数：** 16

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
|---|--------|----------|-----------|------|------|
| 1 | OBJECT_ID | VARCHAR2(100) | 100 | N | 对象ID |
| 2 | S_INFO_WINDCODE | VARCHAR2(40) | 40 | Y | Wind代码 |
| 3 | TRADE_DT | VARCHAR2(8) | 8 | Y | 交易日期 |
| 4 | S_DQ_PRESETTLE | NUMBER(20,4) | 22 | Y | 前结算价(元) |
| 5 | S_DQ_OPEN | NUMBER(20,4) | 22 | Y | 开盘价(元) |
| 6 | S_DQ_HIGH | NUMBER(20,4) | 22 | Y | 最高价(元) |
| 7 | S_DQ_LOW | NUMBER(20,4) | 22 | Y | 最低价(元) |
| 8 | S_DQ_CLOSE | NUMBER(20,4) | 22 | Y | 收盘价(元) |
| 9 | S_DQ_SETTLE | NUMBER(20,4) | 22 | Y | 结算价(元) |
| 10 | S_DQ_VOLUME | NUMBER(20,4) | 22 | Y | 成交量(手) |
| 11 | S_DQ_AMOUNT | NUMBER(20,4) | 22 | Y | 成交金额(万元) |
| 12 | S_DQ_OI | NUMBER(20,4) | 22 | Y | 持仓量(手) |
| 13 | S_DQ_CHANGE | NUMBER(20,4) | 22 | Y | 涨跌(元) |
| 14 | FS_INFO_TYPE | VARCHAR2(10) | 10 | Y | 合约类型 |
| 15 | OPDATE | DATE | 7 | Y |  |
| 16 | OPMODE | VARCHAR2(1) | 1 | Y |  |

---
