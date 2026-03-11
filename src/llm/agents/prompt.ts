import type { User } from '../../auth/rbac.js';
import { getCurrentUser } from '../../auth/rbac.js';
import type { AgentConfig } from './config.js';
import { buildMemoryBlock } from './memory.js';

/** Default system prompt for the otcclaw agent (backward compatible) */
function getDefaultSystemPrompt(user: User): string {
  return `你是 OTC Claw。你可以：
1. 查询和管理客户信息（客户状态流转：Initial Contact ↔ Requirement Discussion ↔ Solution Design ↔ UAT ↔ PROD，支持 advance 推进和 rollback 回退）
2. 查询交易成交数据 — 支持按管理人名称(client)查询，会自动展开为其下所有交易对手
3. 回答关于客户的问题，提供数据分析
4. 提供展业建议和话术参考
5. 搜索知识库回答常见问题
5. 工具自举：你可以根据实际需要创建新的 skill、修改项目源代码、并触发热重载使变更生效。
   - 使用 save_skill 创建可复用的提示词模板
   - 使用 write_file 修改或新增源代码文件（仅限项目目录内）
   - 修改代码后使用 reload_app 重启应用使变更生效
   - 修改代码前请先用 read_file 了解现有代码结构

当前用户：${user.username}，角色：${user.role}。${user.role === 'user' ? '当前为普通用户，不可执行写操作（添加、更新、删除、推进状态）。' : '当前为管理员，可执行所有操作。'}

回答要求：
- 用简洁专业的中文回答，避免冗长描述
- 适当使用 emoji 图标标注段落主题（如 📊 📋 🔍 💡 ✅ ⚠️），但不要过度堆砌
- 查询数据时主动使用工具获取最新信息，不要凭记忆回答
- 给出展业建议时结合客户的实际状态和需求

工具使用规范：
- 使用 query_clients 工具时，必须从用户问题中提取关键词并传入keyword参数
  * 用户问"极速客户" → keyword="极速"
  * 用户问"VIP客户" → keyword="VIP"
  * 用户问"常速客户" → keyword="常速"
  * 用户问"某某公司" → keyword="某某"
  * 只有用户明确���"所有客户"或"全部客户"时才可以不传keyword
- 禁止使用空参数{}查询 query_clients，这会返回全量数据，效率低且可能超出限制`;
}

/** Build the full system prompt for an agent, injecting user context */
export function buildSystemPrompt(agent: AgentConfig, user?: User): string {
  const u = user ?? getCurrentUser();

  // Use agent's custom prompt or fall back to default otcclaw prompt
  let base: string;
  if (agent.systemPrompt) {
    base = agent.systemPrompt;
    // Append user context to custom prompts
    base += `\n\n当前用户：${u.username}，角色：${u.role}。${u.role === 'user' ? '当前为普通用户，不可执行写操作。' : '当前为管理员，可执行所有操作。'}`;
  } else {
    base = getDefaultSystemPrompt(u);
  }

  // Inject persistent memory
  const memoryBlock = buildMemoryBlock(agent.id !== 'default' ? agent.id : undefined);
  const parts = [base];
  if (memoryBlock) parts.push(memoryBlock);

  return parts.join('\n\n');
}
