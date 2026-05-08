## ASHAREINDUSTRIESCODE

**Oracle 表名：** WIND.ASHAREINDUSTRIESCODE

**字段数：** 14


| #   | 字段名                | 数据类型           | 长度/精度 | 可空  | 说明      |
| --- | ------------------ | -------------- | ----- | --- | ------- |
| 1   | OBJECT_ID          | VARCHAR2(100)  | 100   | N   | 对象ID    |
| 2   | INDUSTRIESCODE     | VARCHAR2(38)   | 38    | Y   | 行业代码    |
| 3   | INDUSTRIESNAME     | VARCHAR2(50)   | 50    | Y   | 行业名称    |
| 4   | LEVELNUM           | NUMBER(1)      | 22    | Y   | 级数      |
| 5   | USED               | NUMBER(1)      | 22    | Y   | 是否有效    |
| 6   | INDUSTRIESALIAS    | VARCHAR2(20)   | 20    | Y   | 板块别名    |
| 7   | SEQUENCE           | NUMBER(4)      | 22    | Y   | 展示序号    |
| 8   | MEMO               | VARCHAR2(100)  | 100   | Y   | 备注      |
| 9   | CHINESEDEFINITION  | VARCHAR2(1100) | 1100  | Y   | 板块中文定义  |
| 10  | WIND_NAME_ENG      | VARCHAR2(200)  | 200   | Y   | 板块英文名称  |
| 11  | OPDATE             | DATE           | 7     | Y   |         |
| 12  | OPMODE             | VARCHAR2(1)    | 1     | Y   |         |
| 13  | REGION_CODE        | VARCHAR2(10)   | 10    | Y   | 行政区域代码  |
| 14  | INDUSTRIESCODE_OLD | VARCHAR2(38)   | 38    | Y   | 行业代码(旧) |


---