# Plugin SDK 与生命周期

插件通过 `@samata-platform/plugin-sdk` 暴露统一模块接口。平台加载插件后，将工具定义并入 Agent 工具池，并在执行工具时调用插件 handler。

## 核心接口

- `name` / `description`：插件元数据。
- `scope`：`universal` 或 `agent-bound`。
- `toolDefinitions`：提供给 LLM 的工具 schema。
- `handleTool()`：执行工具。
- `init()`：初始化 schema、配置和私有数据。
- `start()` / `stop()`：启动或停止后台服务。

## 隔离原则

插件不直接查询主库，不 import 核心 `src/` 业务模块。需要的当前用户、数据目录、配置目录等信息通过 `PluginContext` 注入。
