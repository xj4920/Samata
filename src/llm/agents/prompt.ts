import type { User } from '../../auth/rbac.js';
import { getCurrentUser } from '../../auth/rbac.js';
import type { AgentConfig } from './config.js';
import { buildMemoryBlock } from './memory.js';
import { getAllSkills } from '../../commands/skill.js';

/** Default system prompt for the otcclaw agent (backward compatible) */
function getDefaultSystemPrompt(user: User): string {
  return `你是衍语，英文名：OTC Claw。你可以：
1. 查询和管理客户信息（客户状态流转：Initial Contact ↔ Requirement Discussion ↔ Solution Design ↔ UAT ↔ PROD，支持 advance 推进和 rollback 回退 ）
2. 查询交易成交数据 — 支持按管理人名称(client)查询，会自动展开为其下所有交易对手
3. 回答关于客户的问题，提供数据分析
4. 提供展业建议和话术参考
5. 搜索知识库回答常见问题
6. 工具自举：你可以根据实际需要创建新的 skill、修改项目源代码、并触发热重载使变更生效。
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
  * 只有用户明确说"所有客户"或"全部客户"时才可以不传keyword
- 禁止使用空参数{}查询 query_clients，这会返回全量数据，效率低且可能超出限制`;
}

/** Generic system prompt for agents without a custom prompt (non-otcclaw) */
function buildGenericPrompt(agent: AgentConfig, user: User): string {
  return `你是${agent.displayName}。${agent.description ?? ''}

当前用户：${user.username}，角色：${user.role}。

回答要求：
- 用简洁专业的中文回答
- 查询数据时主动使用工具获取最新信息，不要凭记忆回答`;
}

/** Build the full system prompt for an agent, injecting user context */
export function buildSystemPrompt(agent: AgentConfig, user?: User): string {
  const u = user ?? getCurrentUser();
  const agentId = agent.id !== 'default' ? agent.id : undefined;

  let base: string;
  if (agent.systemPrompt) {
    base = agent.systemPrompt;
    // Append user context to custom prompts
    base += `\n\n当前用户：${u.username}，角色：${u.role}。${u.role === 'user' ? '当前为普通用户，不可执行写操作。' : '当前为管理员，可执行所有操作。'}`;
  } else if (agent.name === 'otcclaw') {
    base = getDefaultSystemPrompt(u);
  } else {
    base = buildGenericPrompt(agent, u);
  }

  // Inject available skills
  const skills = getAllSkills(agentId);
  if (skills.length > 0) {
    const skillList = skills.map(s => `- 「${s.name}」: ${s.prompt}`).join('\n');
    base += `\n\n🛠️ **当前可用技能库 (Skills)：**\n你已经学会了以下特定场景的处理技能。当用户的问题匹配这些场景时，请务必严格按照技能定义的逻辑和格式进行回答：\n${skillList}\n\n**技能调用指令：**\n- 当用户要求执行某个技能，或者当前场景符合某个技能描述时，你应该“进入技能模式”。\n- 严格遵循技能 prompt 中的格式要求（如表格布局、汇总方式等）。`;
  }

  // Inject persistent memory
  const memoryBlock = buildMemoryBlock(agentId);
  const parts = [base];
  if (memoryBlock) parts.push(memoryBlock);

  return parts.join('\n\n');
}