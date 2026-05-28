/**
 * Telegram 消息格式化工具
 * 将结构化数据转为 Telegram 友好的纯文本
 */
import type { KnowledgeSearchResult } from '../commands/knowledge.js';
import type { Skill } from '../commands/skill.js';

export function formatKnowledge(result: KnowledgeSearchResult): string {
  const { faq, documents } = result;
  if (faq.length === 0 && documents.length === 0) return '未找到相关结果';

  const lines: string[] = [];

  if (faq.length > 0) {
    lines.push(`📚 FAQ (共 ${faq.length} 条)`, '');
    for (const item of faq) {
      lines.push(`Q: ${item.question}`);
      lines.push(`A: ${item.answer}`);
      if (item.tags) lines.push(`标签: ${item.tags}`);
      lines.push('');
    }
  }

  if (documents.length > 0) {
    lines.push(`📄 文档 (共 ${documents.length} 条)`, '');
    for (const doc of documents) {
      lines.push(`• ${doc.title}`);
      lines.push(`   ${doc.snippet}`);
      if (doc.tags) lines.push(`   标签: ${doc.tags}`);
      lines.push('');
    }
  }

  return lines.join('\n').trimEnd();
}

export function formatSkillList(skills: Skill[]): string {
  if (skills.length === 0) return '暂无已保存的 skill';

  const lines = [`🧩 Skill 列表 (共 ${skills.length} 个)`, ''];
  for (const s of skills) {
    const params = [...new Set([...s.prompt.matchAll(/\{(\w+)\}/g)].map(m => m[1]))];
    const paramStr = params.length > 0 ? `  参数: ${params.join(', ')}` : '';
    lines.push(`• ${s.name}${paramStr}`);
    lines.push(`  ${s.prompt.length > 60 ? s.prompt.slice(0, 60) + '...' : s.prompt}`);
  }
  return lines.join('\n');
}

export function formatSuccess(msg: string): string {
  return `✅ ${msg}`;
}

export function formatError(msg: string): string {
  return `❌ ${msg}`;
}
