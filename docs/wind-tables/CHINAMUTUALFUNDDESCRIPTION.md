## CHINAMUTUALFUNDDESCRIPTION

**说明：** 中国共同基金基本资料

**Oracle 表名：** WIND.CHINAMUTUALFUNDDESCRIPTION

**字段数：** 20（常用字段，完整 84 个）


> 本文档仅列出最常用的 20 个字段（共 84 个）。如需其他字段，用 `information_schema.columns` 查询完整列表。

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
| 1  |OBJECT_ID|VARCHAR2(100)|100|N|对象ID|
| 2  |F_INFO_WINDCODE|VARCHAR2(40)|40|Y|Wind代码:万得自定义的用来识别证券的唯一编码,后缀为交易场所|
| 3  |F_INFO_FULLNAME|VARCHAR2(200)|200|Y|名称:基金名称|
| 4  |F_INFO_NAME|VARCHAR2(100)|100|Y|简称:公司名称的简称；交易所披露该证券的中文简称；每只证券中文简称；该证券的中文简称；证券在公告中公布的简称；证券的中文简称；交易所公布证券的中文简称，若未公布为万得自编简称；|
| 5  |F_INFO_CORP_FUNDMANAGEMENTCOMP|VARCHAR2(100)|100|Y|管理人:公司公布的中文简称；公司中文简称；公司或企业组织的中文名称缩写；公司的简化名称；公司或证券的中文简称；公司名称的中文简短称呼；|
| 6  |F_INFO_CUSTODIANBANK|VARCHAR2(100)|100|Y|托管人:公司公布的中文简称；公司中文简称；公司或企业组织的中文名称缩写；公司的简化名称；公司或证券的中文简称；公司名称的中文简短称呼；|
| 7  |F_INFO_FIRSTINVESTTYPE|VARCHAR2(100)|100|Y|投资类型:根据投资对象的不同划分的基金类型|
| 8  |F_INFO_SETUPDATE|VARCHAR2(8)|8|Y|成立日期:基金合同生效日期|
| 9  |F_INFO_MATURITYDATE|VARCHAR2(8)|8|Y|到期日期:基金终止运作的日期|
| 10 |F_ISSUE_TOTALUNIT|NUMBER(26,10)|22|Y|发行份额:认购阶段结束后最终确认的募集总份额|
| 11 |F_INFO_MANAGEMENTFEERATIO|NUMBER(20,4)|22|Y|管理费:基金管理人收取的费用|
| 12 |F_INFO_CUSTODIANFEERATIO|NUMBER(20,4)|22|Y|托管费:基金托管人为保管和处置基金资产而向基金收取的费用|
| 13 |CRNY_CODE|VARCHAR2(10)|10|Y|货币代码:万得自定义在外汇市场或货币市场上用于交易的货币种类的编码|
| 14 |F_INFO_BENCHMARK|VARCHAR2(500)|500|Y|业绩比较基准:基金收益率和业绩的比较目标|
| 15 |F_INFO_STATUS|NUMBER(9)|22|Y|存续状态:记录万得代码的存续状态，L代表有效，N代表发行还未上市，D代表无效；该证券的存续状态，L代表有效，N代表发行还未上市，D代表无效；判断证券是否合法存在的状态；记录证券的存续状态；记录万得代码对应证券的存续状态，L代表有效，N代表发行还未上市，D代表无效；|
| 16 |F_INFO_EXCHMARKET|VARCHAR2(10)|10|Y|交易所:既定的各个交易所对应的交易所代码；规范后的交易所代码；该证券所在交易所的英文简称；全球市场现有交易所的英文名称；各交易所英文代码缩写；|
| 17 |F_INFO_FIRSTINVESTSTYLE|VARCHAR2(20)|20|Y|投资风格:基金资产在不同类型股票之间配置相对应投资战略或计划的情况|
| 18 |F_INFO_ISSUEDATE|VARCHAR2(8)|8|Y|发行日期:基金份额发售的起始日期|
| 19 |F_INFO_TYPE|VARCHAR2(20)|20|Y|基金类型:基金产品在运行、操作过程中所采用的工作方式|
| 20 |F_INFO_ISINITIAL|NUMBER(5)|22|Y|是否为初始基金:识别该基金代码是否是初始基金（母基金）的标识|

---
