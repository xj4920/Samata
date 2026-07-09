# Plugin Sandbox Root Context

## 背景

部分插件能力需要和 `sandbox_exec` 使用同一个 per-agent/per-user 文件边界。此前 `PluginContext` 只能提供用户、agent ID、data/config 目录和投递上下文，插件无法获得当前 Samata sandbox root，只能自行创建临时目录，难以复用平台的文件隔离模型。

## 改动

- `PluginContext` 新增可选方法 `getSandboxRoot()`。
- Plugin registry 在运行时根据当前 execution context 的 `agent.name` 与 `user.id` 返回现有 sandbox root。
- 该能力是平台通用接口，不包含任何业务插件或私有插件工具名。

## 验证

- `npm run test:unit -- tests/unit/plugins/registry-delivery.test.ts`，3 tests passed。
- `npx tsc -p packages/plugin-sdk/tsconfig.build.json --noEmit`，通过。
- `npx tsc --noEmit` 仍被既有 `src/services/mcp-manager.ts` LogYi 日期类型错误阻塞，和本次插件 sandbox context 改动无关。
