## CHINAMUTUALFUNDSTOCKPORTFOLIO

**Oracle 表名：** WIND.CHINAMUTUALFUNDSTOCKPORTFOLIO

**字段数：** 26

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
|---|--------|----------|-----------|------|------|
| 1 | OBJECT_ID | VARCHAR2(100) | 100 | N | 对象ID |
| 2 | S_INFO_WINDCODE | VARCHAR2(40) | 40 | Y | 基金Wind代码 |
| 3 | F_PRT_ENDDATE | VARCHAR2(8) | 8 | Y | 截止日期 |
| 4 | CRNCY_CODE | VARCHAR2(10) | 10 | Y | 货币代码 |
| 5 | S_INFO_STOCKWINDCODE | VARCHAR2(10) | 10 | Y | 持有股票Wind代码 |
| 6 | F_PRT_STKVALUE | NUMBER(20,4) | 22 | Y | 持有股票市值(元) |
| 7 | F_PRT_STKQUANTITY | NUMBER(20,4) | 22 | Y | 持有股票数量（股） |
| 8 | F_PRT_STKVALUETONAV | NUMBER(20,4) | 22 | Y | 持有股票市值占基金净值比例(%) |
| 9 | F_PRT_POSSTKVALUE | NUMBER(20,4) | 22 | Y | 积极投资持有股票市值(元) |
| 10 | F_PRT_POSSTKQUANTITY | NUMBER(20,4) | 22 | Y | 积极投资持有股数（股） |
| 11 | F_PRT_POSSTKTONAV | NUMBER(20,4) | 22 | Y | 积极投资持有股票市值占净资产比例(%) |
| 12 | F_PRT_PASSTKEVALUE | NUMBER(20,4) | 22 | Y | 指数投资持有股票市值(元) |
| 13 | F_PRT_PASSTKQUANTITY | NUMBER(20,4) | 22 | Y | 指数投资持有股数（股） |
| 14 | F_PRT_PASSTKTONAV | NUMBER(20,4) | 22 | Y | 指数投资持有股票市值占净资产比例(%) |
| 15 | ANN_DATE | VARCHAR2(8) | 8 | Y | 公告日期 |
| 16 | STOCK_PER | NUMBER(20,2) | 22 | Y | 占股票市值比 |
| 17 | FLOAT_SHR_PER | NUMBER(20,2) | 22 | Y | 占流通股本比例 |
| 18 | OPDATE | DATE | 7 | Y |  |
| 19 | OPMODE | VARCHAR2(1) | 1 | Y |  |
| 20 | F_PRT_STKVALUETONAV_CV | NUMBER(20,8) | 22 | Y | 持有股票市值占基金净值比例(计算值) |
| 21 | NUMB_NP_OS | NUMBER(20,4) | 22 | Y | 非公开发行股数 |
| 22 | AVRG_CLSPRICE_NPOS | NUMBER(20,4) | 22 | Y | 非公开发行股期末均价 |
| 23 | S_INFO_INNERCODE | VARCHAR2(40) | 40 | Y | 基金场内代码 |
| 24 | S_INFO_OUTERCODE | VARCHAR2(40) | 40 | Y | 基金场外代码 |
| 25 | SEC_ID | VARCHAR2(10) | 10 | Y | 基金证券ID |
| 26 | REPORT_TYPE | VARCHAR2(10) | 10 | Y | 报告类型 |

---
