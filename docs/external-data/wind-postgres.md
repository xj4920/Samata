# Wind PostgreSQL

当前 Wind 查询以 PostgreSQL 为正式文档口径。Agent 需要先阅读 Wind 文档和表结构索引，再生成查询语句。

## 查询约定

- 日期列使用 PostgreSQL `DATE` 类型和 `YYYY-MM-DD` 格式。
- 优先按文档中的索引字段过滤。
- 大表查询必须限制日期、股票代码、公告期或业务主键范围。

## 入口

- [Wind 金融数据库（PostgreSQL）](../wind-database.md)
- [Wind 数据库表结构索引](../wind-tables-schema.md)
