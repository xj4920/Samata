---
name: 架构图绘制
description: 使用 Mermaid 语法绘制架构图、流程图、时序图等并渲染为 PNG 图片
---

## 何时使用
- 用户要求画架构图、流程图、时序图、ER 图、甘特图等
- 需要可视化系统设计、业务流程、数据流向
- 用户提供了 Mermaid 代码要求渲染成图片

## 支持的图表类型
- `flowchart` / `graph` — 流程图
- `sequenceDiagram` — 时序图
- `classDiagram` — 类图
- `erDiagram` — ER 实体关系图
- `gantt` — 甘特图
- `pie` — 饼图
- `mindmap` — 思维导图
- `stateDiagram-v2` — 状态图
- `gitgraph` — Git 分支图
- `C4Context` / `C4Container` — C4 架构图

## 使用步骤
1. 根据用户需求构造 Mermaid DSL 代码
2. 调用 render_diagram 工具传入 code 参数
3. 得到 PNG 路径后，调用 send_image 发送给用户

## 注意事项
- 节点 ID 不要包含空格，用 camelCase 或下划线
- 含特殊字符的标签用双引号包裹：`A["标签 (备注)"]`
- 避免用 `end` 作为节点 ID（与 subgraph 语法冲突）
- theme 参数可选 default / dark / forest / neutral
- 复杂图表可适当增大 width（默认 1200）
