## CHINAOPTIONDESCRIPTION

**说明：** 中国期权合约基本资料

**Oracle 表名：** WIND.CHINAOPTIONDESCRIPTION

**字段数：** 24

**字段说明来源：** Oracle `ALL_TAB_COLUMNS` + `ALL_COL_COMMENTS`

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
|---|--------|----------|-----------|------|------|
| 1 | OBJECT_ID | VARCHAR2(100) | 100 | N | 对象ID |
| 2 | S_INFO_WINDCODE | VARCHAR2(40) | 40 | Y | 月合约Wind代码 |
| 3 | S_INFO_CODE | VARCHAR2(40) | 40 | Y | 月合约交易所编码 |
| 4 | S_INFO_NAME | VARCHAR2(100) | 100 | Y | 月合约全称 |
| 5 | S_INFO_SCCODE | VARCHAR2(50) | 50 | Y | 期权Wind代码 |
| 6 | S_INFO_CALLPUT | NUMBER(9,0) | 22 | Y | 月合约类别 |
| 7 | S_INFO_STRIKEPRICE | NUMBER(20,4) | 22 | Y | 行权价格 |
| 8 | S_INFO_MONTH | VARCHAR2(6) | 6 | Y | 交割月份 |
| 9 | S_INFO_MATURITYDATE | VARCHAR2(8) | 8 | Y | 到期日 |
| 10 | S_INFO_FTDATE | VARCHAR2(8) | 8 | Y | 开始交易日 |
| 11 | S_INFO_LASTTRADINGDATE | VARCHAR2(8) | 8 | Y | 最后交易日 |
| 12 | S_INFO_EXERCISINGEND | VARCHAR2(8) | 8 | Y | 最后行权日 |
| 13 | S_INFO_LDDATE | VARCHAR2(8) | 8 | Y | 最后交割日 |
| 14 | S_INFO_LPRICE | NUMBER(20,4) | 22 | Y | 挂牌基准价 |
| 15 | S_INFO_TRADE | VARCHAR2(1) | 1 | Y | 是否交易 |
| 16 | S_INFO_EXCODE | VARCHAR2(20) | 20 | Y | 月合约交易所代码 |
| 17 | S_INFO_EXNAME | VARCHAR2(100) | 100 | Y | 月合约交易所简称 |
| 18 | S_INFO_COUNIT | NUMBER(20,4) | 22 | Y | 合约单位 |
| 19 | OPDATE | DATE | 7 | Y |  |
| 20 | OPMODE | VARCHAR2(1) | 1 | Y |  |
| 21 | S_INFO_EXCHANGE_NAME | VARCHAR2(40) | 40 | Y | 交易所简称 |
| 22 | LISTREASON_CODE | NUMBER(9,0) | 22 | Y | 挂牌原因代码 |
| 23 | ADJ_SIGN | VARCHAR2(10) | 10 | Y | 合约调整标志 |
| 24 | SEC_ID | VARCHAR2(10) | 10 | Y | 证券ID |

---
