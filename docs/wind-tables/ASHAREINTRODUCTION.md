## ASHAREINTRODUCTION

**Oracle 表名：** WIND.ASHAREINTRODUCTION

**字段数：** 26

| # | 字段名 | 数据类型 | 长度/精度 | 可空 | 说明 |
|---|--------|----------|-----------|------|------|
| 1 | OBJECT_ID | VARCHAR2(100) | 100 | N | 对象ID |
| 2 | S_INFO_WINDCODE | VARCHAR2(40) | 40 | Y | Wind代码 |
| 3 | S_INFO_PROVINCE | VARCHAR2(20) | 20 | Y | 省份 |
| 4 | S_INFO_CITY | VARCHAR2(20) | 20 | Y | 城市 |
| 5 | S_INFO_CHAIRMAN | VARCHAR2(38) | 38 | Y | 法人代表 |
| 6 | S_INFO_PRESIDENT | VARCHAR2(38) | 38 | Y | 总经理 |
| 7 | S_INFO_BDSECRETARY | VARCHAR2(500) | 500 | Y | 董事会秘书 |
| 8 | S_INFO_REGCAPITAL | NUMBER(20,4) | 22 | Y | 注册资本(万元) |
| 9 | S_INFO_FOUNDDATE | VARCHAR2(8) | 8 | Y | 成立日期 |
| 10 | S_INFO_CHINESEINTRODUCTION | VARCHAR2(2000) | 2000 | Y | 公司中文简介 |
| 11 | S_INFO_COMPTYPE | VARCHAR2(20) | 20 | Y | 公司类型 |
| 12 | S_INFO_WEBSITE | VARCHAR2(80) | 80 | Y | 主页 |
| 13 | S_INFO_EMAIL | VARCHAR2(80) | 80 | Y | 电子邮箱 |
| 14 | S_INFO_OFFICE | VARCHAR2(300) | 300 | Y | 办公地址 |
| 15 | ANN_DT | VARCHAR2(8) | 8 | Y | 公告日期 |
| 16 | S_INFO_COUNTRY | VARCHAR2(20) | 20 | Y | 国籍 |
| 17 | S_INFO_COMPANY_TYPE | VARCHAR2(10) | 10 | Y | 公司类别 |
| 18 | S_INFO_TOTALEMPLOYEES | NUMBER(20) | 22 | Y | 员工总数(人) |
| 19 | OPDATE | DATE | 7 | Y |  |
| 20 | OPMODE | VARCHAR2(1) | 1 | Y |  |
| 21 | IS_PROFIT | VARCHAR2(1) | 1 | Y | [废弃]是否盈利(交易所) |
| 22 | IS_VIE | VARCHAR2(1) | 1 | Y | 是否VIE(协议控制) |
| 23 | S_INFO_MAIN_BUSINESS | CLOB | 4000 | Y | 主要产品及业务 |
| 24 | S_INFO_BUSINESSSCOPE | CLOB | 4000 | Y | 经营范围 |
| 25 | COMP_ID | VARCHAR2(40) | 40 | Y | 公司ID |
| 26 | COMP_NAME | VARCHAR2(200) | 200 | Y | 公司名称 |

---
