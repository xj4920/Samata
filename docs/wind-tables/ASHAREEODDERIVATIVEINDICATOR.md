## ASHAREEODDERIVATIVEINDICATOR

**说明：** 中国A股日行情估值指标

**Oracle 表名：** WIND.ASHAREEODDERIVATIVEINDICATOR

**字段数：** 20（常用字段，完整 45 个）


> 本文档仅列出最常用的 20 个字段（共 45 个）。如需其他字段，用 `information_schema.columns` 查询完整列表。

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
| 1  |OBJECT_ID|VARCHAR2(100)|100|N|对象ID|
| 2  |S_INFO_WINDCODE|VARCHAR2(40)|40|Y|Wind代码:万得自定义的用来识别证券的唯一编码,后缀为交易场所|
| 3  |TRADE_DT|VARCHAR2(8)|8|Y|交易日期:该只证券的交易日期|
| 4  |CRNCY_CODE|VARCHAR2(10)|10|Y|交易货币代码:用于区分货币币种的代码|
| 5  |S_VAL_MV|NUMBER(20,4)|22|Y|当日总市值:当日总股本与当日收盘价的乘积|
| 6  |S_DQ_MV|NUMBER(20,4)|22|Y|当日流通市值:流通股数量乘以当日交易日收盘价|
| 7  |S_PQ_HIGH_52W_|NUMBER(20,4)|22|Y|近1年最高价:该只证券近一年最高价|
| 8  |S_PQ_LOW_52W_|NUMBER(20,4)|22|Y|近1年最低价:该只证券近一年最低价|
| 9  |S_VAL_PE|NUMBER(20,4)|22|Y|市盈率(LYR):每股股价收益比率|
| 10 |S_VAL_PB_NEW|NUMBER(20,4)|22|Y|市净率(LF):每股股价与每股净资产的比率|
| 11 |S_VAL_PE_TTM|NUMBER(20,4)|22|Y|市盈率(PE,TTM):每股股价与每股净资产的比率(静态)，算法：市盈率（PE，TTM)=总市值/净利润（TTM)，其中：总市值=股价*总股本；总股本=A股股价*公司发行在外普通股总数(多地上市股份总和)；净利润（TTM)=最新报告期净利润＋上年年报净利润－上年同期净利润，如上述三个报告期中缺少其中任何一期，则净利润（TTM）=上年年报净利润。|
| 12 |S_VAL_PS_TTM|NUMBER(20,4)|22|Y|市销率(TTM):股价与每股销售额的比率(静态)|
| 13 |S_DQ_TURN|NUMBER(20,4)|22|Y|换手率:本股票转手买卖的频率|
| 14 |S_DQ_FREETURNOVER|NUMBER(20,4)|22|Y|换手率(基准.自由流通股本):规定时间内市场中股票转手买卖的频率|
| 15 |TOT_SHR_TODAY|NUMBER(24,8)|22|Y|当日总股本:该只证券的当日总股本|
| 16 |FLOAT_A_SHR_TODAY|NUMBER(24,8)|22|Y|当日流通股本:可以在交易所流通的股份数量|
| 17 |S_DQ_CLOSE_TODAY|NUMBER(20,4)|22|Y|当日收盘价:股票收盘时的价格|
| 18 |FREE_SHARES_TODAY|NUMBER(24,8)|22|Y|当日自由流通股本:可供投资者在公开证券市场上购买的股份|
| 19 |NET_PROFIT_PARENT_COMP_TTM|NUMBER(20,4)|22|Y|归属母公司净利润(TTM):企业合并净利润中,归属于母公司股东(所有者)所有的净利润(动态)|
| 20 |NET_ASSETS_TODAY|NUMBER(20,4)|22|Y|当日净资产:企业的资产总额减去负债以后的净额|

---
