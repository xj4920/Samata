import type { User } from '../../auth/rbac.js';
import { getCurrentUser, isAgentAdmin, isAgentMember, isSystemAdmin } from '../../auth/rbac.js';
import type { AgentConfig } from './config.js';
import { buildMemoryBlock } from './memory.js';
import { getAllSkills } from '../../commands/skill.js';
import { getPluginSkills } from '../../plugins/registry.js';
import { getExecutionChannel } from '../../runtime/execution-context.js';

const ATTACHMENT_GUIDANCE = `附件发送规范：
- 需要给当前对话用户发送 CSV、TXT、Markdown 等文件时，先用 write_artifact 写入 /tmp/samata，再调用 send_file
- 需要发送图片时，可先用 markdown_to_image 生成 PNG，再调用 send_image
- markdown_to_image 只负责生成图片，不等于已经发送成功
- 不要只说“文件已保存”或“图片已生成”，如果用户要求发送附件，必须继续调用 send_file 或 send_image`;

/** Default system prompt for the otcclaw agent (backward compatible) */
function buildPermissionText(user: User, agent?: AgentConfig): string {
  const channel = getExecutionChannel();
  const parts = [`当前接入渠道：${channel}`, `当前用户：${user.username}，系统角色：${user.role}`];

  if (isSystemAdmin()) {
    parts.push('你当前是 CLI 系统管理员，可管理全局 memory/knowledge/skill，也可管理所有 agent。');
    return parts.join('。') + '。';
  }

  if (agent && isAgentAdmin(agent.id)) {
    parts.push(`你当前是 Agent「${agent.displayName}」的管理员，可写当前 Agent 的 memory/knowledge/skill，但不可操作全局资源。`);
    return parts.join('。') + '。';
  }

  if (agent && isAgentMember(agent.id)) {
    parts.push(`你当前是 Agent「${agent.displayName}」的普通成员，可查询和使用当前 Agent 资源，不可新增、修改、删除。`);
    return parts.join('。') + '。';
  }

  parts.push('你当前没有写权限，只能执行只读查询和使用型操作。');
  return parts.join('。') + '。';
}

/** Default system prompt for the otcclaw agent (backward compatible) */
function getDefaultSystemPrompt(user: User, agent?: AgentConfig): string {
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

${buildPermissionText(user, agent)}

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
- 禁止使用空参数{}查询 query_clients，这会返回全量数据，效率低且可能超出限制

${ATTACHMENT_GUIDANCE}`;
}

/** Generic system prompt for agents without a custom prompt (non-otcclaw) */
function buildGenericPrompt(agent: AgentConfig, user: User): string {
  return `你是${agent.displayName}。${agent.description ?? ''}

${buildPermissionText(user, agent)}

回答要求：
- 用简洁专业的中文回答
- 查询数据时主动使用工具获取最新信息，不要凭记忆回答

${ATTACHMENT_GUIDANCE}`;
}

/** Build the full system prompt for an agent, injecting user context */
export function buildSystemPrompt(agent: AgentConfig, user?: User): string {
  const u = user ?? getCurrentUser();
  const agentId = agent.id !== 'default' ? agent.id : undefined;

  let base: string;
  if (agent.systemPrompt) {
    base = agent.systemPrompt;
    // Append user context to custom prompts
    base += `\n\n${buildPermissionText(u, agent)}`;
  } else if (agent.name === 'otcclaw') {
    base = getDefaultSystemPrompt(u, agent);
  } else {
    base = buildGenericPrompt(agent, u);
  }
  if (!base.includes('send_file')) {
    base += `\n\n${ATTACHMENT_GUIDANCE}`;
  }

  // Inject available skills (DB skills + plugin skills, name + description only)
  const dbSkills = getAllSkills(agentId);
  const pluginSkillEntries = getPluginSkills();

  const skillLines: string[] = [];
  for (const s of dbSkills) {
    skillLines.push(`- 「${s.name}」: ${s.description ?? s.prompt.slice(0, 60).replace(/\n/g, ' ')}`);
  }
  for (const ps of pluginSkillEntries) {
    if (!dbSkills.some(s => s.name === ps.name)) {
      skillLines.push(`- 「${ps.name}」: ${ps.description}`);
    }
  }
  if (skillLines.length > 0) {
    base += `\n\n🛠️ **可用技能 (Skills)：**\n${skillLines.join('\n')}\n\n当场景匹配某个技能时，使用 run_skill 执行，使用 get_skill 获取完整内容。`;
  }

  // Inject persistent memory
  const memoryBlock = buildMemoryBlock(agentId);
  const parts = [base];
  if (memoryBlock) parts.push(memoryBlock);

  return parts.join('\n\n');
}