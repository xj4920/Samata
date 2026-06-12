## ASHAREDIVIDEND

**说明：** 中国A股分红

**Oracle 表名：** WIND.ASHAREDIVIDEND

**字段数：** 18（常用字段，完整 43 个）


> 本文档仅列出最常用的 18 个字段（共 43 个）。如需其他字段，用 `information_schema.columns` 查询完整列表。

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
| 1  |OBJECT_ID|VARCHAR2(100)|100|N|对象ID|
| 2  |S_INFO_WINDCODE|VARCHAR2(40)|40|Y|Wind代码|
| 3  |S_DIV_PROGRESS|VARCHAR2(10)|10|Y|方案进度|
| 4  |STK_DVD_PER_SH|NUMBER(20,8)|22|Y|每股送转|
| 5  |CASH_DVD_PER_SH_PRE_TAX|NUMBER(24,8)|22|Y|每股派息(税前)(元)|
| 6  |CASH_DVD_PER_SH_AFTER_TAX|NUMBER(24,8)|22|Y|每股派息(税后)(元)|
| 7  |EQY_RECORD_DT|VARCHAR2(8)|8|Y|股权登记日|
| 8  |EX_DT|VARCHAR2(8)|8|Y|除权除息日|
| 9  |DVD_PAYOUT_DT|VARCHAR2(8)|8|Y|派息日|
| 10 |S_DIV_PRELANDATE|VARCHAR2(8)|8|Y|预案公告日|
| 11 |DVD_ANN_DT|VARCHAR2(8)|8|Y|分红实施公告日|
| 12 |S_DIV_BASESHARE|NUMBER(20,4)|22|Y|基准股本(万股)|
| 13 |CRNCY_CODE|VARCHAR2(10)|10|Y|货币代码|
| 14 |ANN_DT|VARCHAR2(8)|8|Y|最新公告日期|
| 15 |REPORT_PERIOD|VARCHAR2(8)|8|Y|分红年度|
| 16 |S_DIV_BONUSRATE|NUMBER(20,8)|22|Y|每股送股比例|
| 17 |S_DIV_CONVERSEDRATE|NUMBER(20,8)|22|Y|每股转增比例|
| 18 |TOT_CASH_DVD|NUMBER(20,4)|22|Y|现金分红总额|

---
