---
layout: home

hero:
  name: Samata
  text: 多 Agent 智能助手平台文档
  tagline: 汇总平台架构、Agent 能力模型、权限体系、Dream 机制与业务数据说明。
  actions:
    - theme: brand
      text: 阅读架构概览
      link: /agent-skills-tools-knowledge-memory-overview
    - theme: alt
      text: 查看权限机制
      link: /permission-system

features:
  - title: Agent 能力模型
    details: 说明 Memory、Tools、Skills、Knowledge 如何组成 Samata 的 Agent 上下文。
  - title: 权限与隔离
    details: 梳理 System Admin、Agent Admin、Agent User 与渠道隔离规则。
  - title: 业务数据文档
    details: 汇总 Wind 数据库连接、表结构索引和分表字段说明。
---

## 本地运行

```bash
npm run docs:dev
```

## 构建静态站点

```bash
npm run docs:build
```

构建产物默认输出到 `docs/.vitepress/dist`。
