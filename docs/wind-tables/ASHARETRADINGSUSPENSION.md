## ASHARETRADINGSUSPENSION

**Oracle 表名：** WIND.ASHARETRADINGSUSPENSION

**字段数：** 10

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
|---|--------|----------|-----------|------|------|
| 1 | OBJECT_ID | VARCHAR2(100) | 100 | N | 对象ID |
| 2 | S_INFO_WINDCODE | VARCHAR2(40) | 40 | Y | Wind代码 |
| 3 | S_DQ_SUSPENDDATE | VARCHAR2(8) | 8 | Y | 停牌日期 |
| 4 | S_DQ_SUSPENDTYPE | NUMBER(9) | 22 | Y | 停牌类型代码 |
| 5 | S_DQ_RESUMPDATE | VARCHAR2(8) | 8 | Y | 复牌日期 |
| 6 | S_DQ_CHANGEREASON | VARCHAR2(400) | 400 | Y | 停牌原因 |
| 7 | S_DQ_TIME | VARCHAR2(200) | 200 | Y | 停复牌时间 |
| 8 | S_DQ_CHANGEREASONTYPE | NUMBER(9) | 22 | Y | 停牌原因代码 |
| 9 | OPDATE | DATE | 7 | Y |  |
| 10 | OPMODE | VARCHAR2(1) | 1 | Y |  |

---
