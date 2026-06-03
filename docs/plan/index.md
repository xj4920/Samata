# 演进记录

`docs/plan` 保留 Samata 的阶段性设计、执行计划、迁移方案和问题复盘原文。这些页面用于追溯，不再作为独立的文档模块呈现。

## 呈现方式

- **正式文档**：按平台介绍、权限控制、Dream、插件机制、外部数据五个模块组织，是主阅读路径。
- **演进记录**：保留原始计划和复盘文本，由各模块侧边栏的“相关设计/演进记录”引用。
- **联动机制**：每篇 plan 通过 frontmatter 的 `docModules`、`docTopics` 和 `canonicalDocs` 自动挂到对应模块。

## 新增记录

新增 `docs/plan/YYYY-MM-DD_topic.md` 时，需要在文件头补充：

```yaml
---
docModules:
  - platform
docTopics:
  platform: 渠道与会话
status: implemented
canonicalDocs:
  - /platform/channels-and-sessions
---
```

然后执行：

```bash
npm run docs:plan-sync
```

生成的索引文件由 VitePress 侧边栏使用，不要手工编辑。
