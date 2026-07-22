# 文件与沙箱白名单

文件读取和 sandbox 挂载是高风险能力，必须按 Agent 白名单控制。

## read_file

Agent 的可读路径由 `config/agents/<name>.files.json` 控制。没有白名单的 Agent 不应默认读取业务文件；有白名单时也只能读取列出的文档或目录。

## sandbox

sandbox 工具执行时只读挂载白名单中的资料。这样可以让 Agent 在隔离环境里查询数据、运行脚本，同时避免访问仓库或主机上的其他文件。

## 退役数据源

数据源退役时，应同时清理 Agent 提示词、文件白名单和 sandbox 工具说明，避免 Agent 继续读取已失效的连接文档或尝试访问下线服务。
