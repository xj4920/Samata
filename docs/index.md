---
layout: home

hero:
  name: Samata
  text: 多 Agent 智能助手平台文档
  tagline: 汇总平台介绍、权限控制、Dream、插件机制与外部数据能力。
  actions:
    - theme: brand
      text: 阅读平台介绍
      link: /platform/
    - theme: alt
      text: 查看外部数据
      link: /external-data/

features:
  - title: 平台介绍
    details: 说明 Samata 的 Agent 运行时、渠道接入、会话上下文和通用工具。
  - title: 权限与插件
    details: 梳理 System Admin、Agent Admin、Agent User、工具可见性和插件绑定机制。
  - title: Dream 与外部数据
    details: 汇总 Dream 经验沉淀、Wind PostgreSQL、报价交易、Wiki 与浏览器能力。
---

## 本地运行

```bash
npm run docs:dev
```

`docs:dev` 会先同步 `docs/plan` 元数据索引，再启动 VitePress。

## 构建静态站点

```bash
npm run docs:check
```

构建产物默认输出到 `docs/.vitepress/dist`。
