# Dream 机制

Dream 的核心流程是：读取遥测记录，构建可回放上下文，调用 LLM 提炼经验，再写入 Agent 级经验文件。

## 数据流

```text
telemetry turns -> dream analyze -> data/dreams/<agent>/<date>.md -> prompt injection
```

## Prompt 注入

Agent prompt 模板中可以保留 Dream 占位符。构建 system prompt 时，平台读取最新经验文件并替换到模板中。

## 边界

Dream 不替代事实知识库，也不应记录敏感正文，除非观测配置显式允许。它更适合沉淀工具使用习惯、失败模式和交互策略。
