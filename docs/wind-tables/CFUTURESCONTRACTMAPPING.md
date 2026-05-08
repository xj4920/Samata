## CFUTURESCONTRACTMAPPING

**Oracle 表名：** WIND.CFUTURESCONTRACTMAPPING

**字段数：** 8


| #   | 字段名                 | 数据类型          | 长度/精度 | 可空  | 说明             |
| --- | ------------------- | ------------- | ----- | --- | -------------- |
| 1   | OBJECT_ID           | VARCHAR2(100) | 100   | N   | 对象ID           |
| 2   | S_INFO_WINDCODE     | VARCHAR2(40)  | 40    | Y   | 连续(主力)合约Wind代码 |
| 3   | FS_MAPPING_WINDCODE | VARCHAR2(20)  | 20    | Y   | 映射月合约Wind代码    |
| 4   | STARTDATE           | VARCHAR2(8)   | 8     | Y   | 起始日期           |
| 5   | ENDDATE             | VARCHAR2(8)   | 8     | Y   | 截止日期           |
| 6   | CONTRACT_ID         | VARCHAR2(10)  | 10    | Y   | 合约ID           |
| 7   | OPDATE              | DATE          | 7     | Y   |                |
| 8   | OPMODE              | VARCHAR2(1)   | 1     | Y   |                |


---