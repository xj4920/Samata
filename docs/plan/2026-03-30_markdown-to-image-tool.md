---
docModules:
  - platform
  - plugins
docTopics:
  platform: 通用工具
  plugins: 工具插件目录
canonicalDocs:
  - /platform/common-tools
  - /plugins/catalog
status: implemented
---

# Plan: Markdown → Image Tool

**Date:** 2026-03-30

## 目标

新增 `markdown_to_image` tool，将 Markdown 文本渲染为 PNG 图片，使飞书 bot 可以返回图片形式的富文本内容。

## 实现方案

### 渲染引擎
使用 **puppeteer**（headless Chrome），通过 HTML+CSS 模板将 Markdown 渲染为高质量 PNG。

**流程：**
1. Markdown → HTML（内联 CSS 样式模板）
2. Puppeteer 打开 HTML → 截图为 PNG
3. 保存到 `/tmp/md_<uuid>.png`
4. 返回文件路径

飞书 bot 的 `processImagesInText()` 会自动检测 `/tmp/...png` 路径并上传到飞书，替换为 `![image](img_key)`。

### 文件变更

| 文件 | 操作 |
|------|------|
| `package.json` | 安装 `puppeteer` |
| `src/tools/markdown-tools.ts` | 新建 tool 模块 |
| `src/llm/tool-types.ts` | 新增 `MarkdownToImageInput` 类型 |
| `src/tools/index.ts` | 注册 markdownTools 模块 |

### Tool 定义

```typescript
name: 'markdown_to_image'
参数:
  markdown: string   // 必填，Markdown 内容
  width?: number     // 可选，图片宽度，默认 800px
  theme?: 'light' | 'dark'  // 可选，主题，默认 light
```

### HTML 模板特性
- GitHub-style Markdown 样式
- 代码高亮（预渲染 CSS，无需 JS）
- 支持表格、列表、标题、引用、行内代码等
- 自动适配宽度

## 注意事项

- 图片存放于 `/tmp/`，无需持久化
- 工具无权限限制，所有用户均可调用
- puppeteer 首次运行会下载 Chromium，需确保网络可访问
