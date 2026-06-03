# Wind 与沙箱

需要在隔离环境中查询 Wind 数据时，Agent 应通过白名单读取 Wind PostgreSQL 文档，再使用 sandbox 执行查询脚本。

## 基本流程

1. `read_file` 读取 `docs/wind-database.md` 或 `docs/wind-tables-schema.md`。
2. 根据文档生成 PostgreSQL 查询。
3. 在 sandbox 中执行脚本。
4. 汇总结果并说明查询口径。

## 约束

- sandbox 只能访问白名单挂载的文档。
- 不使用 Oracle 连接方式。
- 查询失败时返回错误原因和下一步建议，不循环盲试。
