# 资源作用域

Samata 的核心资源分为全局资源和 Agent 级资源。不同作用域决定保存、更新、删除时需要的权限。

## 全局资源

全局 memory、knowledge、skill 面向多个 Agent 或系统级使用。写入和删除全局资源需要 System Admin。

## Agent 级资源

Agent memory、Agent skill、Agent knowledge、documents 与指定 Agent 绑定。写入和删除需要 System Admin 或对应 Agent Admin。

## 读取规则

读取通常比写入宽松。Agent 对话可以读取全局资源和当前 Agent 资源，但不能越权读取其他 Agent 的私有资料。
