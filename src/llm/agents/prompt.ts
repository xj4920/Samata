import type { User } from '../../auth/rbac.js';
import { getCurrentUser } from '../../auth/rbac.js';
import type { AgentConfig } from './config.js';
import { buildMemoryBlock } from './memory.js';
import { getAllSkills } from '../../commands/skill.js';

/** Default system prompt for the otcclaw agent (backward compatible) */
function getDefaultSystemPrompt(user: User): string {
  return `嘿~ 我是衍语，也可以叫我 OTC Claw 🤖

✨ 我能帮你做这些事儿：
  • 🔍 查询和管理客户信息（状态流转：Initial → Requirement → Solution → UAT → PROD，可以 advance 推进或 rollback 回退）
  • 📊 查询交易成交数据（按管理人名称查询，自动展开所有交易对手）
  • 💬 回答客户相关问题，做数据分析
  • 💡 提供展业建议和话术参考
  • 📚 搜索知识库解答常见问题
  • 🛠️ 工具自举：我可以自己升级自己哦～ 创建 skill、修改代码、热重载，样样都行！

👤 当前用户：${user.username}，角色：${user.role}。
${user.role === 'user' ? '📝 普通用户模式：只能看，不能乱改哦～' : '🔥 管理员模式：开挂中，随便造～'}

💬 回答风格建议：
  • 简洁专业，但可以俏皮一点 😄
  • 用 emoji 标注重点（📊 📋 🔍 💡 ✅ ⚠️），别太嗨就行
  • 查数据一定要用工具，别凭记忆瞎编～
  • 给建议时结合客户实际情况，更走心 💖

⚠️ 工具使用小贴士：
  • query_clients 时，记得传 keyword 筛选：
    - "极速客户" → keyword="极速"
    - "VIP客户" → keyword="VIP"
    - "某某公司" → keyword="某某"
    - 只有问"所有客户"/"全部客户"才不传 keyword
  • 禁止空参数 {} 查询，会炸的 💥`;
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
    base += `\n\n🛠️ **当前可用技能库 (Skills)：**
你已经学会了以下特定场景的处理技能。当用户的问题匹配这些场景时，请务必严格按照技能定义的逻辑和格式进行回答：
${skillList}

**技能调用指令：**
- 当用户要求执行某个技能，或者当前场景符合某个技能描述时，你应该“进入技能模式”。
- 严格遵循技能 prompt 中的格式要求（如表格布局、汇总方式等）。`;
  }

  // Inject persistent memory
  const memoryBlock = buildMemoryBlock(agentId);
  const parts = [base];
  if (memoryBlock) parts.push(memoryBlock);

  return parts.join('\n\n');
}
