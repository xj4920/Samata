## ASHARESTOCKRATINGCONSUS

**Oracle 表名：** WIND.ASHARESTOCKRATINGCONSUS

**字段数：** 18


| #   | 字段名                         | 数据类型          | 长度/精度 | 可空  | 说明          |
| --- | --------------------------- | ------------- | ----- | --- | ----------- |
| 1   | OBJECT_ID                   | VARCHAR2(100) | 100   | N   | 对象ID        |
| 2   | S_INFO_WINDCODE             | VARCHAR2(40)  | 40    | Y   | Wind代码      |
| 3   | RATING_DT                   | VARCHAR2(8)   | 8     | Y   | 日期          |
| 4   | S_WRATING_AVG               | NUMBER(20,4)  | 22    | Y   | 综合评级        |
| 5   | S_WRATING_INSTNUM           | NUMBER(20,4)  | 22    | Y   | 评级机构数量      |
| 6   | S_WRATING_UPGRADE           | NUMBER(20,4)  | 22    | Y   | 调高家数（相比一月前） |
| 7   | S_WRATING_DOWNGRADE         | NUMBER(20,4)  | 22    | Y   | 调低家数（相比一月前） |
| 8   | S_WRATING_MAINTAIN          | NUMBER(20,4)  | 22    | Y   | 维持家数（相比一月前） |
| 9   | S_WRATING_NUMOFBUY          | NUMBER(20,4)  | 22    | Y   | 买入家数        |
| 10  | S_WRATING_NUMOFOUTPERFORM   | NUMBER(20,4)  | 22    | Y   | 增持家数        |
| 11  | S_WRATING_NUMOFHOLD         | NUMBER(20,4)  | 22    | Y   | 中性家数        |
| 12  | S_WRATING_NUMOFUNDERPERFORM | NUMBER(20,4)  | 22    | Y   | 减持家数        |
| 13  | S_WRATING_NUMOFSELL         | NUMBER(20,4)  | 22    | Y   | 卖出家数        |
| 14  | S_WRATING_CYCLE             | VARCHAR2(10)  | 10    | Y   | 周期          |
| 15  | S_EST_PRICE                 | NUMBER(20,4)  | 22    | Y   | 一致预测目标价     |
| 16  | S_EST_PRICEINSTNUM          | NUMBER(20,4)  | 22    | Y   | 目标价预测机构数    |
| 17  | OPDATE                      | DATE          | 7     | Y   |             |
| 18  | OPMODE                      | VARCHAR2(1)   | 1     | Y   |             |


---