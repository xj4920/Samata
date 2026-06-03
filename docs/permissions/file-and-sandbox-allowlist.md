# 文件与沙箱白名单

文件读取和 sandbox 挂载是高风险能力，必须按 Agent 白名单控制。

## read_file

Agent 的可读路径由 `config/agents/<name>.files.json` 控制。没有白名单的 Agent 不应默认读取业务文件；有白名单时也只能读取列出的文档或目录。

## sandbox

sandbox 工具执行时只读挂载白名单中的资料。这样可以让 Agent 在隔离环境里查询数据、运行脚本，同时避免访问仓库或主机上的其他文件。

## Wind 场景

TiClaw 等需要 Wind 数据能力的 Agent，应白名单开放 Wind PostgreSQL 文档和表结构索引，再在 sandbox 中按文档执行查询。
