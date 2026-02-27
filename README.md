# 衍语 (YanYu)

客户展业全生命周期管理系统，为销售团队提供从初次接触到上线投产的全流程客户跟踪，内置 AI 助手辅助日常操作。

## 功能特性

- 客户生命周期管理 — 5 阶段流转：初次接触 → 需求沟通 → 方案设计 → UAT 测试 → 上线投产
- AI 助手 — 基于 Claude 的自然语言交互，支持工具调用自动执行操作
- 知识库 — FAQ 管理，快速检索常见问题
- 插件系统 — 可扩展架构，内置 CSV 导出插件
- 权限控制 — 基于角色的访问控制（admin / user）
- 数据导入 — 支持 Excel 批量导入客户数据
- 操作审计 — 完整的事件日志记录

## 技术栈

- TypeScript + Node.js
- SQLite（better-sqlite3，WAL 模式）
- Anthropic Claude SDK
- Inquirer.js 交互式命令行

## 快速开始

```bash
# 安装依赖
npm install

# 配置环境变量
cp .env.example .env
# 编辑 .env，填入 ANTHROPIC_API_KEY

# 启动（支持热重载）
npm start

# 开发模式
npm run dev
```

## 环境变量

| 变量 | 说明 |
|------|------|
| `ANTHROPIC_API_KEY` | Anthropic API 密钥 |
| `ANTHROPIC_AUTH_TOKEN` | 自定义网关认证令牌（可选） |
| `ANTHROPIC_BASE_URL` | 自定义网关地址（可选） |

## 命令列表

| 命令 | 说明 | 权限 |
|------|------|------|
| `/add` | 新增客户 | admin |
| `/update` | 更新客户信息 | admin |
| `/delete` | 删除客户 | admin |
| `/advance` | 推进客户阶段 | admin |
| `/list` | 查看客户列表 | all |
| `/view` | 查看客户详情 | all |
| `/history` | 查看操作历史 | all |
| `/status` | 状态看板 | all |
| `/faq` | 查询知识库 | all |
| `/faq-add` | 添加 FAQ | admin |
| `/faq-del` | 删除 FAQ | admin |
| `/plugin` | 插件管理 | all |
| `/skill` | 自定义技能 | all |
| `/help` | 帮助信息 | all |
| `/reset` | 重置会话 | all |

输入非命令文本时，将自动转交 AI 助手以自然语言处理。

## 项目结构

```
src/
├── index.ts          # 入口，交互式 REPL
├── auth/             # 权限控制
├── commands/         # 命令处理器
├── db/               # 数据库连接与 Schema
├── llm/              # AI 代理（Claude）
├── models/           # 数据模型
├── plugins/          # 插件系统
├── scripts/          # 数据导入工具
└── utils/            # 日志、表格渲染
```

## License

ISC
