## CHINAMUTUALFUNDSECTOR

**Oracle 表名：** WIND.CHINAMUTUALFUNDSECTOR

**字段数：** 12


| #   | 字段名                  | 数据类型          | 长度/精度 | 可空  | 说明        |
| --- | -------------------- | ------------- | ----- | --- | --------- |
| 1   | OBJECT_ID            | VARCHAR2(100) | 100   | N   | 对象ID      |
| 2   | F_INFO_WINDCODE      | VARCHAR2(40)  | 40    | Y   | Wind代码    |
| 3   | S_INFO_SECTOR        | VARCHAR2(40)  | 40    | Y   | 所属板块      |
| 4   | S_INFO_SECTORENTRYDT | VARCHAR2(8)   | 8     | Y   | 起始日期      |
| 5   | S_INFO_SECTOREXITDT  | VARCHAR2(8)   | 8     | Y   | 截止日期      |
| 6   | CUR_SIGN             | VARCHAR2(10)  | 10    | Y   | 最新标志      |
| 7   | OPDATE               | DATE          | 7     | Y   |           |
| 8   | OPMODE               | VARCHAR2(1)   | 1     | Y   |           |
| 9   | S_INFO_OUTERCODE     | VARCHAR2(40)  | 40    | Y   | 基金场外代码    |
| 10  | SEC_ID               | VARCHAR2(10)  | 10    | Y   | 证券ID      |
| 11  | S_INFO_SECTOR_NEW    | VARCHAR2(40)  | 40    | Y   | 所属板块代码(新) |
| 12  | S_INFO_INNERCODE     | VARCHAR2(40)  | 40    | Y   | 基金场内代码    |


---