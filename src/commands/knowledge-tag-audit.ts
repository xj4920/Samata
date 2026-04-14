import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { getDb } from '../db/connection.js';
import { getCurrentAgent } from '../llm/agent.js';
import { getAgentById } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import { remoteConfirm, remoteSelect } from '../runtime/execution-context.js';
import { updateKnowledgeById, type KnowledgeItem } from './knowledge.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MONITOR_CONFIG_PATH = path.resolve(__dirname, '../../config/monitor.json');

/** 从 config/monitor.json 读取某 Agent 的知识库标签白名单 */
export function loadKnowledgeTagsFromConfig(agentId: string): string[] {
  if (!fs.existsSync(MONITOR_CONFIG_PATH)) return [];
  try {
    const cfg = JSON.parse(fs.readFileSync(MONITOR_CONFIG_PATH, 'utf-8'));
    const tags = cfg.knowledge?.tags ?? {};
    const directTags = tags[agentId];
    if (Array.isArray(directTags)) return directTags.map(String);

    const agent = getAgentById(agentId);
    const nameTags = agent?.name ? tags[agent.name] : undefined;
    return Array.isArray(nameTags) ? nameTags.map(String) : [];
  } catch {
    return [];
  }
}

function resolveConfigTagKey(agentId: string): string {
  if (!fs.existsSync(MONITOR_CONFIG_PATH)) return agentId;
  try {
    const cfg = JSON.parse(fs.readFileSync(MONITOR_CONFIG_PATH, 'utf-8'));
    const tags = cfg.knowledge?.tags ?? {};
    if (Array.isArray(tags[agentId])) return agentId;

    const agent = getAgentById(agentId);
    if (agent?.name && Array.isArray(tags[agent.name])) return agent.name;
    return agent?.name || agentId;
  } catch {
    return agentId;
  }
}

function appendKnowledgeTagsToConfig(agentId: string, newTags: string[]): { success: boolean; added: string[]; error?: string } {
  if (!newTags.length) return { success: true, added: [] };
  if (!fs.existsSync(MONITOR_CONFIG_PATH)) {
    return { success: false, added: [], error: '未找到 config/monitor.json' };
  }

  try {
    const cfg = JSON.parse(fs.readFileSync(MONITOR_CONFIG_PATH, 'utf-8'));
    if (!cfg.knowledge) cfg.knowledge = {};
    if (!cfg.knowledge.tags) cfg.knowledge.tags = {};

    const configKey = resolveConfigTagKey(agentId);
    const existing = Array.isArray(cfg.knowledge.tags[configKey]) ? cfg.knowledge.tags[configKey].map(String) : [];
    const merged = [...existing];
    const added: string[] = [];

    for (const tag of newTags.map(t => t.trim()).filter(Boolean)) {
      if (!merged.includes(tag)) {
        merged.push(tag);
        added.push(tag);
      }
    }

    cfg.knowledge.tags[configKey] = merged;
    fs.writeFileSync(MONITOR_CONFIG_PATH, `${JSON.stringify(cfg, null, 2)}\n`, 'utf-8');
    return { success: true, added };
  } catch (err: any) {
    return { success: false, added: [], error: err.message ?? String(err) };
  }
}

function parseTags(s: string | null): string[] {
  if (!s?.trim()) return [];
  return s.split(',').map(t => t.trim()).filter(Boolean);
}

function joinTags(tags: string[]): string {
  return tags.join(',');
}

/** 按与问题/答案的匹配度对白名单标签排序，取前若干名 */
export function rankTagCandidates(tagPool: string[], question: string, answer: string, take = 3): string[] {
  const text = `${question}\n${answer}`;
  const uniq = [...new Set(tagPool)];
  const scored = uniq.map(tag => {
    let score = 0;
    if (text.includes(tag)) score += 20;
    for (const ch of tag) {
      if (ch.trim()) score += (text.match(new RegExp(ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) ?? []).length;
    }
    return { tag, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, take).map(s => s.tag);
}

/**
 * CLI：核对当前 Agent 关联的知识条目 tags 是否在 monitor.json 白名单内；
 * 若有非法标签，展示三条推荐后由用户确认是否写回。
 */
export async function cliAuditKnowledgeTags(): Promise<void> {
  const agent = getCurrentAgent();
  if (!agent) {
    log.print('未选择 Agent');
    return;
  }

  let allowed = loadKnowledgeTagsFromConfig(agent.id);
  if (allowed.length === 0) {
    log.print(
      `未在 config/monitor.json 的 knowledge.tags 中为「${agent.name}」或「${agent.id}」配置标签列表，无法核对。`,
    );
    return;
  }

  const initialAllowedSet = new Set(allowed);
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT k.* FROM knowledge k
       INNER JOIN knowledge_agents ka ON ka.knowledge_id = k.id AND ka.agent_id = ?`,
    )
    .all(agent.id) as KnowledgeItem[];

  const mismatched = rows.filter(row => {
    const tags = parseTags(row.tags);
    return tags.some(t => !initialAllowedSet.has(t));
  });

  if (mismatched.length === 0) {
    log.print('知识标签与 monitor.json 白名单一致。');
    return;
  }

  log.print(`共 ${mismatched.length} 条知识含白名单外的标签，逐一处理（Ctrl+C 可中断）…`);

  for (const row of mismatched) {
    const allowedSet = new Set(allowed);
    const originalTags = parseTags(row.tags);
    const invalid = originalTags.filter(t => !allowedSet.has(t));
    if (invalid.length === 0) continue;

    log.print('');
    log.print(`— ${row.id.slice(0, 8)} —`);
    const qPreview = row.question.length > 160 ? `${row.question.slice(0, 160)}…` : row.question;
    log.print(qPreview);
    log.print(`当前标签: ${row.tags || '（无）'}`);

    const finalTags = [...originalTags];

    for (const badTag of invalid) {
      log.print(`  ▸ 非法标签「${badTag}」`);

      const top3 = rankTagCandidates(allowed, row.question, row.answer, 3);
      const choices: Array<{ name: string; value: string }> = top3.map(t => ({
        name: `候选项-${t}`,
        value: t,
      }));
      choices.push({ name: '移除该标签', value: '__remove__' });
      choices.push({ name: `加入「${badTag}」到白名单`, value: '__append_whitelist__' });

      const picked = await remoteSelect(`「${badTag}」→`, choices);

      if (picked === '__append_whitelist__') {
        const appendResult = appendKnowledgeTagsToConfig(agent.id, [badTag]);
        if (appendResult.success && appendResult.added.length > 0) {
          allowed = loadKnowledgeTagsFromConfig(agent.id);
          log.print(`    已加入白名单: ${badTag}`);
        } else if (appendResult.success) {
          log.print(`    「${badTag}」已在白名单中`);
        } else {
          log.print(`    写入失败: ${appendResult.error}`);
        }
        continue;
      } else if (picked === '__remove__') {
        const idx = finalTags.indexOf(badTag);
        if (idx >= 0) finalTags.splice(idx, 1);
        log.print(`    将移除「${badTag}」`);
      } else {
        const idx = finalTags.indexOf(badTag);
        if (idx >= 0) finalTags[idx] = picked;
        else finalTags.push(picked);
        log.print(`    「${badTag}」→「${picked}」`);
      }
    }

    const newTagsStr = joinTags([...new Set(finalTags)]);
    if (newTagsStr === joinTags(originalTags)) {
      log.print('  标签未变化。');
      continue;
    }

    const preview = newTagsStr || '（清空标签）';
    const ok = await remoteConfirm(`将标签更新为「${preview}」？`, true);
    if (!ok) {
      log.print('  已取消本条。');
      continue;
    }

    const result = updateKnowledgeById(
      row.id.slice(0, 8),
      { tags: newTagsStr },
      agent.id,
    );
    if (result.success) {
      log.print('  已更新。');
    } else {
      log.print(`  ${result.error ?? '更新失败'}`);
    }
  }

  log.print('');
  log.print('核对流程结束。');
}
