# Wind 数据库表结构索引

本文档是 28 张 Wind 同步表的**总览**：表名、数据含义、字段数（以分表文档为准）。**完整列定义**已拆到 `[docs/wind-tables/](wind-tables/)` 下各 `*.md`，查询前请用 `read_file` 打开对应文件。

> 若某表标注「常用字段 N 个，完整 M 个」，表示 `wind-tables` 中只列了常用列；需其他列时用 PostgreSQL `information_schema.columns` 查全量。


| #   | 表名                            | 字段数           | 说明                    | 分表文档                                                                                           |
| --- | ----------------------------- | ------------- | --------------------- | ---------------------------------------------------------------------------------------------- |
| 1   | AINDEXEODPRICES               | 16            | 中国A股指数日行情             | `[wind-tables/AINDEXEODPRICES.md](wind-tables/AINDEXEODPRICES.md)`                             |
| 2   | ASHAREEODPRICES               | 28            | 中国A股日行情               | `[wind-tables/ASHAREEODPRICES.md](wind-tables/ASHAREEODPRICES.md)`                             |
| 3   | ASHAREEODDERIVATIVEINDICATOR  | 20（常用，完整 44）  | 中国A股日行情估值指标           | `[wind-tables/ASHAREEODDERIVATIVEINDICATOR.md](wind-tables/ASHAREEODDERIVATIVEINDICATOR.md)`   |
| 4   | ASHAREBALANCESHEET            | 20（常用，完整 192） | 中国A股资产负债表             | `[wind-tables/ASHAREBALANCESHEET.md](wind-tables/ASHAREBALANCESHEET.md)`                       |
| 5   | ASHARECASHFLOW                | 20（常用，完整 126） | 中国A股现金流量表             | `[wind-tables/ASHARECASHFLOW.md](wind-tables/ASHARECASHFLOW.md)`                               |
| 6   | ASHAREINCOME                  | 22（常用，完整 114） | 中国A股利润表               | `[wind-tables/ASHAREINCOME.md](wind-tables/ASHAREINCOME.md)`                                   |
| 7   | ASHAREDIVIDEND                | 18（常用，完整 43）  | 中国A股分红                | `[wind-tables/ASHAREDIVIDEND.md](wind-tables/ASHAREDIVIDEND.md)`                               |
| 8   | ASHARETRADINGSUSPENSION       | 10            | A股停复牌                 | `[wind-tables/ASHARETRADINGSUSPENSION.md](wind-tables/ASHARETRADINGSUSPENSION.md)`             |
| 9   | ASHAREISACTIVITY              | 11            | 中国A股机构调研活动            | `[wind-tables/ASHAREISACTIVITY.md](wind-tables/ASHAREISACTIVITY.md)`                           |
| 10  | ASHARECALENDAR                | 5             | A股交易日历                | `[wind-tables/ASHARECALENDAR.md](wind-tables/ASHARECALENDAR.md)`                               |
| 11  | ASHAREINDUSTRIESCODE          | 14            | A股行业分类（代码字典，非证券–行业映射） | `[wind-tables/ASHAREINDUSTRIESCODE.md](wind-tables/ASHAREINDUSTRIESCODE.md)`                   |
| 12  | ASHAREINTRODUCTION            | 26            | 公司基本资料                | `[wind-tables/ASHAREINTRODUCTION.md](wind-tables/ASHAREINTRODUCTION.md)`                       |
| 13  | ASHARECONSENSUSDATA           | 18（常用，完整 96）  | A股一致预期                | `[wind-tables/ASHARECONSENSUSDATA.md](wind-tables/ASHARECONSENSUSDATA.md)`                     |
| 14  | ASHARESTOCKRATINGCONSUS       | 18            | 投资评级一致预期              | `[wind-tables/ASHARESTOCKRATINGCONSUS.md](wind-tables/ASHARESTOCKRATINGCONSUS.md)`             |
| 15  | CFUTURESCONTRACTMAPPING       | 8             | 国内期货连续合约与月份合约映射       | `[wind-tables/CFUTURESCONTRACTMAPPING.md](wind-tables/CFUTURESCONTRACTMAPPING.md)`             |
| 16  | CINDEXFUTURESEODPRICES        | 16            | 国内指数期货日行情             | `[wind-tables/CINDEXFUTURESEODPRICES.md](wind-tables/CINDEXFUTURESEODPRICES.md)`               |
| 17  | CCOMMODITYFUTURESEODPRICES    | 17            | 国内商品期货日行情             | `[wind-tables/CCOMMODITYFUTURESEODPRICES.md](wind-tables/CCOMMODITYFUTURESEODPRICES.md)`       |
| 18  | CFUTURESDESCRIPTION           | 19            | 国内期货合约基本资料            | `[wind-tables/CFUTURESDESCRIPTION.md](wind-tables/CFUTURESDESCRIPTION.md)`                     |
| 19  | CHINAOPTIONEODPRICES          | 21            | 中国期权日行情               | `[wind-tables/CHINAOPTIONEODPRICES.md](wind-tables/CHINAOPTIONEODPRICES.md)`                   |
| 20  | CHINAOPTIONDESCRIPTION        | 24            | 中国期权合约基本资料            | `[wind-tables/CHINAOPTIONDESCRIPTION.md](wind-tables/CHINAOPTIONDESCRIPTION.md)`               |
| 21  | CHINAMUTUALFUNDSTOCKPORTFOLIO | 26            | 中国共同基金股票投资组合          | `[wind-tables/CHINAMUTUALFUNDSTOCKPORTFOLIO.md](wind-tables/CHINAMUTUALFUNDSTOCKPORTFOLIO.md)` |
| 22  | CHINAMUTUALFUNDDESCRIPTION    | 20（常用，完整 83）  | 中国共同基金基本资料            | `[wind-tables/CHINAMUTUALFUNDDESCRIPTION.md](wind-tables/CHINAMUTUALFUNDDESCRIPTION.md)`       |
| 23  | CHINAMUTUALFUNDMANAGER        | 18            | 中国共同基金经理              | `[wind-tables/CHINAMUTUALFUNDMANAGER.md](wind-tables/CHINAMUTUALFUNDMANAGER.md)`               |
| 24  | CHINAMUTUALFUNDSECTOR         | 12            | 中国共同基金行业配置            | `[wind-tables/CHINAMUTUALFUNDSECTOR.md](wind-tables/CHINAMUTUALFUNDSECTOR.md)`                 |
| 25  | CHINACLOSEDFUNDEODPRICE       | 28            | 封闭式基金日行情              | `[wind-tables/CHINACLOSEDFUNDEODPRICE.md](wind-tables/CHINACLOSEDFUNDEODPRICE.md)`             |
| 26  | SHSCCHANNELHOLDINGS           | 9             | 沪深港通通道持股（陆股通等）        | `[wind-tables/SHSCCHANNELHOLDINGS.md](wind-tables/SHSCCHANNELHOLDINGS.md)`                     |
| 27  | SHSCTOP10ACTIVESTOCKS         | 11            | 沪深港通十大成交活跃股票          | `[wind-tables/SHSCTOP10ACTIVESTOCKS.md](wind-tables/SHSCTOP10ACTIVESTOCKS.md)`                 |
| 28  | ASHAREST                      | 10            | A股 ST 及风险警示           | `[wind-tables/ASHAREST.md](wind-tables/ASHAREST.md)`                                           |


---

连接信息与查询注意事项见 `[wind-database.md](wind-database.md)`。
