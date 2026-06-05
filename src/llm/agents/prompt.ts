import fs from 'fs';
import { resolve, join } from 'path';
import type { User } from '../../auth/rbac.js';
import { getCurrentUser, isAgentAdmin, isAgentMember, isSystemAdmin } from '../../auth/rbac.js';
import type { AgentConfig } from './config.js';
import { buildMemoryBlock } from './memory.js';
import { buildDateTimeBlock } from '../../commands/date.js';
import { getAllSkills } from '../../commands/skill.js';
import { getPluginSkills } from '../../plugins/registry.js';
import { getExecutionChannel } from '../../runtime/execution-context.js';
import { loadWorkspace } from '../../session/workspace.js';
import { loadDreamFile } from '../../services/dream-analyze.js';
import { getAgentFsName } from '../../commands/document-import.js';
import { areChromiumToolsDisabled, chromiumToolsDisabledMessage } from '../../runtime/chromium-tools.js';

const ATTACHMENT_GUIDANCE = `附件发送规范：
- 需要给当前对话用户发送 CSV、TXT、Markdown 等文件时，先用 write_artifact 写入 /tmp/samata，再调用 send_file
- 当用户提供 PDF、Excel、Word、图片等文件 URL 时，先用 download_file 保存为本地文件，再调用对应解析或发送工具；不要用 http_request 读取二进制文件，也不要用 write_artifact 伪造文件
- 需要发送图片时，可先用 markdown_to_image 生成 PNG，再调用 send_image
- markdown_to_image 只负责生成图片，不等于已经发送成功
- 不要只说“文件已保存”或“图片已生成”，如果用户要求发送附件，必须继续调用 send_file 或 send_image`;

const PROMPTS_DIR = resolve(process.cwd(), 'config/agents');

function buildPermissionText(user: User, agent?: AgentConfig): string {
  const channel = getExecutionChannel();
  const displayName = user.display_name || user.username;
  const parts = [
    `当前接入渠道：${channel}`,
    `当前提问人：${displayName}`,
    `Samata 用户 ID：${user.id}`,
    `当前用户：${user.username}，系统角色：${user.role}`,
    '身份识别规则：用户说“我”“本人”“我的”时，默认指当前提问人。',
  ];

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

/**
 * Load the prompt template for an agent.
 * Priority: agents.custom_prompt (DB) > config/agents/<name>.md > config/agents/_default.md
 */
function loadPromptTemplate(agent: AgentConfig): string {
  if (agent.customPrompt) return agent.customPrompt;
  const primary = join(PROMPTS_DIR, `${agent.name}.md`);
  if (fs.existsSync(primary)) return fs.readFileSync(primary, 'utf-8');
  const fallback = join(PROMPTS_DIR, '_default.md');
  return fs.readFileSync(fallback, 'utf-8');
}

/**
 * Render a prompt template by substituting {{key}} placeholders.
 * - Known keys with empty values render as an empty string.
 * - Unknown keys are left as-is for easier debugging.
 * - Consecutive blank lines are collapsed and the result is trimmed.
 */
function renderPrompt(template: string, vars: Record<string, string>): string {
  return template
    .replace(/\{\{([\w.]+)\}\}/g, (match, key) => (key in vars ? vars[key] : match))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function stripDevtoolsGuidance(prompt: string): string {
  return prompt
    .replace(/\n?浏览器工具（mcp_devtools_\* 系列）：\n(?:\s*\n)?(?:-[^\n]*\n?)+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Build the "available skills" block (DB + plugin skills). Returns '' when there are no skills. */
function buildSkillsBlock(agentId?: string): string {
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
  if (skillLines.length === 0) return '';
  return `🛠️ **可用技能 (Skills)：**\n${skillLines.join('\n')}\n\n当场景匹配某个技能时，使用 run_skill 执行，使用 get_skill 获取完整内容。`;
}

/** Build the dream block from per-agent dream file. Returns '' when no dream exists. */
function buildDreamBlock(agentName: string): string {
  const content = loadDreamFile(agentName);
  if (!content) return '';
  return content;
}

/** Build wiki guidance block. Only shown when the agent has wiki content or file_to_wiki tool. */
function buildWikiGuidance(agentId?: string): string {
  if (!agentId) return '';
  const wikiDir = join(process.cwd(), 'data', 'wiki', getAgentFsName(agentId));
  const hasWiki = fs.existsSync(wikiDir) && fs.readdirSync(wikiDir).some(d => !d.startsWith('.'));

  const guidance = [
    '知识 Wiki 规范：',
    '- search_knowledge 返回的 wiki 结果是已编译的综合知识，优先参考',
    '- 当回答综合了 2+ 个知识源（文档/FAQ/wiki），或发现文档间的关联、矛盾、互补关系时，调用 file_to_wiki 将洞察持久化',
    '- 用户明确要求"记住这个"或"总结一下"时，也应调用 file_to_wiki',
    '- **严禁在 wiki 中写入未经知识库验证的信息**：file_to_wiki 的 content 必须完全来源于 search_knowledge 返回的结果，每条信息标注 [来源: FAQ/文档标题]',
    '- wiki 页面是覆盖式更新（非追加），写入时应包含该主题的完整最新理解',
  ];

  if (hasWiki) {
    guidance.push(`- 当前 Wiki 已有内容，可通过 search_knowledge 检索`);
    guidance.push('- wiki 页面中的 [[xxx]] 是关联页面链接；当需要更完整上下文时，对链接目标再次 search_knowledge 即可跟链获取');
  }

  return guidance.join('\n');
}

/** Build the full system prompt for an agent, injecting user context */
export function buildSystemPrompt(agent: AgentConfig, user?: User): string {
  const u = user ?? getCurrentUser();
  const agentId = agent.id !== 'default' ? agent.id : undefined;

  const template = loadPromptTemplate(agent);
  const vars: Record<string, string> = {
    'agent.displayName': agent.displayName,
    'agent.description': agent.description ?? '',
    permissions: buildPermissionText(u, agent),
    attachments: ATTACHMENT_GUIDANCE,
    skills: buildSkillsBlock(agentId),
    memory: buildMemoryBlock(agentId) ?? '',
    dream: buildDreamBlock(agent.name),
    wiki_guidance: buildWikiGuidance(agentId),
    user_context: loadWorkspace(agent.name, u.id),
    datetime: buildDateTimeBlock(),
  };
  const rendered = renderPrompt(template, vars);
  if (!areChromiumToolsDisabled()) return rendered;

  return [
    stripDevtoolsGuidance(rendered),
    `生产环境工具限制：${chromiumToolsDisabledMessage()}`,
  ].filter(Boolean).join('\n\n');
}
