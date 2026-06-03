# DeepSeek 官方 Provider

## Context

DeepSeek 已通过广发内部网关 (GF provider) 以 `external-deepseek-v4-pro` / `external-deepseek-v4-flash` 名称提供。现在需要增加 DeepSeek 官方 API 直连 provider，让用户可以直接使用 DeepSeek 官方 API，不经过内部网关。

DeepSeek API 兼容 OpenAI 协议，base URL 为 `https://api.deepseek.com`，也支持 Anthropic 协议 (`https://api.deepseek.com/anthropic`)。采用 OpenAI 兼容路径（复用已有的 `openai-compat.ts` 转换层），与 GF provider 模式一致。

## 修改文件清单

### 1. 新建 `src/llm/deepseek.ts` — DeepSeek Provider 工厂

参考 `src/llm/gf.ts` 的结构，核心差异：
- 读取 `DEEPSEEK_API_KEY` 环境变量（不存在时返回 null，provider 不注册）
- base URL: `https://api.deepseek.com`
- `DEEPSEEK_MODEL` 环境变量控制默认模型
- `availableModels`: `['deepseek-v4-flash', 'deepseek-v4-pro']`
- 复用 `src/llm/openai-compat.ts` 的 `convertTools`, `convertMessages`, `convertResponse`, `parseSSEStream`
- 无 vision model（暂不实现 `describeImage`）

### 2. 修改 `src/llm/provider.ts` — 注册新 provider

- `ProviderName` 类型新增 `'deepseek'`
- `initProviders()` 中 import 并注册 `createDeepseekProvider()`

### 3. 修改 `.env` — 添加配置项（手动告知用户）

```bash
# DeepSeek 官方 API
DEEPSEEK_API_KEY=sk-xxx
DEEPSEEK_MODEL=deepseek-v4-flash
```

## 关键设计决策

- **沿用 OpenAI 兼容路径**：不重复造轮子，直接复用 `openai-compat.ts` 的 Anthropic↔OpenAI 格式转换
- **无 API key 时静默跳过**：与 GF/minimax/gemini 等 provider 一致，key 缺失时返回 null，不影响其他 provider 加载
- **`availableModels` 白名单**：支持 `/model deepseek-v4-flash` 快捷切换
- **不实现 `describeImage`**：用户未提及 vision 需求，保持简洁

## 验证

1. 在 `.env` 中配置 `DEEPSEEK_API_KEY`
2. 启动 server: `npm run server`
3. 确认日志输出 `DeepSeek provider 已注册`
4. 若 `LLM_PROVIDER=deepseek`，确认日志 `AI 助手已启用 [deepseek/deepseek-v4-flash]`
5. CLI 中执行 `/model list` 确认 deepseek provider 及模型列表出现
6. CLI 中执行 `/model deepseek` 切换 provider
7. 发送对话测试非流式响应
8. 发送对话测试流式响应 (SSE)
9. 使用 tool calling 测试 tool use 循环
