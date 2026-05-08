## ASHARECONSENSUSDATA

**Oracle 表名：** WIND.ASHARECONSENSUSDATA

**字段数：** 18（常用字段，完整 97 个）


> 本文档仅列出最常用的 18 个字段（共 97 个）。如需其他字段，用 `information_schema.columns` 查询完整列表。

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
| 1  |OBJECT_ID|VARCHAR2(100)|100|N|对象ID|
| 2  |S_INFO_WINDCODE|VARCHAR2(40)|40|Y|Wind代码|
| 3  |EST_DT|VARCHAR2(8)|8|Y|预测日期|
| 4  |EST_REPORT_DT|VARCHAR2(8)|8|Y|预测报告期|
| 5  |NUM_EST_INST|NUMBER(20)|22|Y|预测机构家数|
| 6  |EPS_AVG|NUMBER(20,4)|22|Y|每股收益平均值(元)|
| 7  |MAIN_BUS_INC_AVG|NUMBER(20,4)|22|Y|主营业务收入平均值(万元)|
| 8  |NET_PROFIT_AVG|NUMBER(20,4)|22|Y|净利润平均值(万元)|
| 9  |EBITDA_AVG|NUMBER(20,4)|22|Y|息税折旧摊销前利润平均值(万元)|
| 10 |EPS_MEDIAN|NUMBER(20,4)|22|Y|每股收益中值(元)|
| 11 |MAIN_BUS_INC_MEDIAN|NUMBER(20,4)|22|Y|主营业务收入中值(万元)|
| 12 |NET_PROFIT_MEDIAN|NUMBER(20,4)|22|Y|净利润中值(万元)|
| 13 |CONSEN_DATA_CYCLE_TYP|VARCHAR2(10)|10|Y|综合值周期类型|
| 14 |NET_PROFIT_UPGRADE|NUMBER(20,4)|22|Y|净利润调高家数（与一个月前相比）|
| 15 |NET_PROFIT_DOWNGRADE|NUMBER(20,4)|22|Y|净利润调低家数（与一个月前相比）|
| 16 |NET_PROFIT_MAINTAIN|NUMBER(20,4)|22|Y|净利润维持家数（与一个月前相比）|
| 17 |S_EST_AVGBPS|NUMBER(20,4)|22|Y|每股净资产平均值|
| 18 |S_EST_AVGROE|NUMBER(20,4)|22|Y|净资产收益率平均值（%）|

---
