## SHSCTOP10ACTIVESTOCKS

**Oracle 表名：** WIND.SHSCTOP10ACTIVESTOCKS

**字段数：** 11


| #   | 字段名                   | 数据类型          | 长度/精度 | 可空  | 说明      |
| --- | --------------------- | ------------- | ----- | --- | ------- |
| 1   | OBJECT_ID             | VARCHAR2(100) | 100   | N   | 对象ID    |
| 2   | S_INFO_WINDCODE       | VARCHAR2(40)  | 40    | Y   | Wind代码  |
| 3   | TRADE_DT              | VARCHAR2(8)   | 8     | Y   | 日期      |
| 4   | MARKET                | VARCHAR2(100) | 100   | Y   | 市场      |
| 5   | BUYTRADEVALUE         | NUMBER(20,4)  | 22    | Y   | 买入金额    |
| 6   | SELLTRADEVALUE        | NUMBER(20,4)  | 22    | Y   | 卖出金额    |
| 7   | TOTALTRADEVALUE       | NUMBER(20,4)  | 22    | Y   | 成交金额    |
| 8   | CRNCY_CODE            | VARCHAR2(10)  | 10    | Y   | 货币代码    |
| 9   | S_INFO_EXCHMARKETNAME | VARCHAR2(40)  | 40    | Y   | 交易所英文简称 |
| 10  | OPDATE                | DATE          | 7     | Y   |         |
| 11  | OPMODE                | VARCHAR2(1)   | 1     | Y   |         |


---