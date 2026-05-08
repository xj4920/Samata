## CFUTURESDESCRIPTION

**Oracle 表名：** WIND.CFUTURESDESCRIPTION

**字段数：** 19

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
|---|--------|----------|-----------|------|------|
| 1 | OBJECT_ID | VARCHAR2(100) | 100 | N | 对象ID |
| 2 | S_INFO_WINDCODE | VARCHAR2(40) | 40 | Y | Wind代码 |
| 3 | S_INFO_CODE | VARCHAR2(40) | 40 | Y | 交易代码 |
| 4 | S_INFO_NAME | VARCHAR2(50) | 50 | Y | 证券中文简称 |
| 5 | S_INFO_ENAME | VARCHAR2(200) | 200 | Y | 证券英文简称 |
| 6 | FS_INFO_SCCODE | VARCHAR2(50) | 50 | Y | 标准合约代码 |
| 7 | FS_INFO_TYPE | NUMBER(1) | 22 | Y | 合约类型 |
| 8 | FS_INFO_CCTYPE | NUMBER(9) | 22 | Y | 连续合约类型 |
| 9 | S_INFO_EXCHMARKET | VARCHAR2(10) | 10 | Y | 交易所 |
| 10 | S_INFO_LISTDATE | VARCHAR2(8) | 8 | Y | 上市日期 |
| 11 | S_INFO_DELISTDATE | VARCHAR2(8) | 8 | Y | 最后交易日期 |
| 12 | FS_INFO_DLMONTH | VARCHAR2(8) | 8 | Y | 交割月份 |
| 13 | FS_INFO_LPRICE | NUMBER(20,4) | 22 | Y | 挂牌基准价 |
| 14 | FS_INFO_LTDLDATE | VARCHAR2(8) | 8 | Y | 最后交割日 |
| 15 | S_INFO_FULLNAME | VARCHAR2(50) | 50 | Y | 证券中文名称 |
| 16 | S_INFO_VOUCHERDATE | VARCHAR2(8) | 8 | Y | 交券日 |
| 17 | S_INFO_PAYMENTDATE | VARCHAR2(8) | 8 | Y | 缴款日 |
| 18 | OPDATE | DATE | 7 | Y |  |
| 19 | OPMODE | VARCHAR2(1) | 1 | Y |  |

---
