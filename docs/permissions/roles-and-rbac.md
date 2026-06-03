# 角色与 RBAC

Samata 使用两层角色：系统角色和 Agent 成员角色。

## 系统角色

- **System Admin**：系统级管理员，可管理全局资源、所有 Agent、模型和系统配置。
- **User**：普通系统用户，不自动拥有任何 Agent 管理权。

## Agent 成员角色

- **Agent Admin**：可管理指定 Agent 的配置、成员、Agent 级 skill、memory、knowledge 和部分工具授权。
- **Agent User**：可与指定 Agent 对话，使用被授权的工具。

## 判断原则

系统管理员是全局权限，Agent 管理员是某个 Agent 范围内的权限。保存全局资源需要 System Admin；保存 Agent 级资源需要 System Admin 或对应 Agent Admin。
