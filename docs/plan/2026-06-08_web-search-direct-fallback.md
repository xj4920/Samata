---
docModules:
  - platform
  - external-data
docTopics:
  platform: 工具系统
  external-data: Web 访问
canonicalDocs:
  - /platform/common-tools
  - /external-data/web-and-browser
status: implemented
---

# Web 搜索直连 fallback 修复（2026-06-08）

## 背景

doctor 执行健康播报时，`web_search` 在 Serper 搜索超时后直接返回错误，没有继续尝试已有的搜狗、Bing 搜索 fallback。运行环境中配置了代理变量，Serper 请求可能仍按环境走代理；但国内搜索 fallback 需要直连，避免代理链路影响可用性。

## 决策

- 保留 Serper 作为优先搜索引擎。
- Serper 抛错、超时或没有结果时，继续 fallback 到搜狗，再 fallback 到 Bing。
- 搜狗和 Bing 使用 `axios.create({ proxy: false })`，并在请求配置里显式 `proxy: false`，确保 fallback 不走运行环境代理。

## 改动

- `web_search` 改为按搜索引擎分别捕获异常，避免一个上游失败中断后续 fallback。
- 搜狗、Bing 搜索请求显式关闭 axios 代理。
- 无结果返回中带上搜索引擎失败信息，便于后续排障。
- 新增单测覆盖 Serper 超时后直连搜狗、搜狗无解析结果后直连 Bing。

## 验证

- `npx vitest run tests/unit/tools/web-search.test.ts`
- `npx tsc --noEmit`
- 使用无效 `SERPER_API_KEY` 实测 `web_search 广州天气` 返回 `engine: "sogou"`。
