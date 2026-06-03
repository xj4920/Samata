# Agent 能力模型

Agent 的回答能力由配置、工具、技能、知识、记忆和文档共同组成。正式运行时不会把所有资料一次性塞进上下文，而是按需注入摘要、目录或检索结果。

## 组成

- **Agent 配置**：名称、描述、prompt 模板、工具模式、工具列表、成员关系。
- **Tools**：可执行动作，包括核心工具、插件工具和 MCP 工具。
- **Skills**：教模型何时使用某类工具、如何组织步骤和输出。
- **Knowledge**：结构化 FAQ 或文档导入后的可检索知识。
- **Memory**：长期偏好、背景信息和 Agent 级上下文。
- **Documents / Wiki**：外部资料、Markdown 文档、Wiki 页面和来源追踪。

## 注入流程

构建 system prompt 时，平台会读取 Agent 模板并替换权限、附件、技能、记忆、时间等占位符。知识和文档通常通过工具按需检索，避免上下文过载。

更完整的历史说明见 [Agent / Skill / Tool / Knowledge / Memory 综述](../agent-skills-tools-knowledge-memory-overview.md)。
