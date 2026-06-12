## CHINACLOSEDFUNDEODPRICE

**说明：** 封闭式基金日行情

**Oracle 表名：** WIND.CHINACLOSEDFUNDEODPRICE

**字段数：** 28

**字段说明来源：** Oracle `ALL_TAB_COLUMNS` + `ALL_COL_COMMENTS`

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
|---|--------|----------|-----------|------|------|
| 1 | OBJECT_ID | VARCHAR2(100) | 100 | N | 对象ID |
| 2 | S_INFO_WINDCODE | VARCHAR2(40) | 40 | Y | Wind代码 |
| 3 | TRADE_DT | VARCHAR2(8) | 8 | Y | 交易日期 |
| 4 | CRNCY_CODE | VARCHAR2(10) | 10 | Y | 货币代码 |
| 5 | S_DQ_PRECLOSE | NUMBER(20,4) | 22 | Y | 昨收盘价(元) |
| 6 | S_DQ_OPEN | NUMBER(20,4) | 22 | Y | 开盘价(元) |
| 7 | S_DQ_HIGH | NUMBER(20,4) | 22 | Y | 最高价(元) |
| 8 | S_DQ_LOW | NUMBER(20,4) | 22 | Y | 最低价(元) |
| 9 | S_DQ_CLOSE | NUMBER(20,4) | 22 | Y | 收盘价(元) |
| 10 | S_DQ_CHANGE | NUMBER(20,4) | 22 | Y | 涨跌(元) |
| 11 | S_DQ_PCTCHANGE | NUMBER(20,4) | 22 | Y | 涨跌幅(%) |
| 12 | S_DQ_VOLUME | NUMBER(20,4) | 22 | Y | 成交量(手) |
| 13 | S_DQ_AMOUNT | NUMBER(20,4) | 22 | Y | 成交金额(千元) |
| 14 | S_DQ_ADJPRECLOSE | NUMBER(20,4) | 22 | Y | 复权昨收盘价(元) |
| 15 | S_DQ_ADJOPEN | NUMBER(20,4) | 22 | Y | 复权开盘价(元) |
| 16 | S_DQ_ADJHIGH | NUMBER(20,4) | 22 | Y | 复权最高价(元) |
| 17 | S_DQ_ADJLOW | NUMBER(20,4) | 22 | Y | 复权最低价(元) |
| 18 | S_DQ_ADJCLOSE | NUMBER(20,4) | 22 | Y | 复权收盘价(元) |
| 19 | S_DQ_ADJFACTOR | NUMBER(20,6) | 22 | Y | 复权因子 |
| 20 | TRADES_COUNT | NUMBER(20,4) | 22 | Y | 成交笔数 |
| 21 | DISCOUNT_RATE | NUMBER(20,6) | 22 | Y | 贴水率（%） |
| 22 | OPDATE | DATE | 7 | Y |  |
| 23 | OPMODE | VARCHAR2(1) | 1 | Y |  |
| 24 | S_DQ_AVGPRICE | NUMBER(20,4) | 22 | Y | 均价(VWAP) |
| 25 | S_DQ_TRADESTATUS | VARCHAR2(10) | 10 | Y | 交易状态 |
| 26 | SEC_ID | VARCHAR2(10) | 10 | Y | 证券ID |
| 27 | S_DQ_TRADESTATUSCODE | NUMBER(5,0) | 22 | Y | 交易状态代码 |
| 28 | DISCOUNT_PREMIUM_RATE | NUMBER(20,4) | 22 | Y | 折溢价率 |

---
