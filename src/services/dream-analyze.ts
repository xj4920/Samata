/**
 * dream-analyze.ts
 * Analyzes daily telemetry data per agent, calls LLM to synthesize tool usage lessons,
 * and writes consolidated dream files for prompt injection.
 */
import fs from 'fs';
import { resolve, dirname } from 'path';
import { getDb } from '../db/connection.js';
import { getProvider, getModelName } from '../llm/provider.js';
import { getAllAgents } from '../llm/agents/config.js';
import { log } from '../utils/logger.js';
import type { TelemetryToolCall } from '../telemetry/types.js';

const DREAMS_DIR = resolve(process.cwd(), 'data/dreams');
const MAX_DREAM_LENGTH = 3000;

export interface DreamTurnSummary {
  agent_id: string;
  channel: string;
  loop_rounds: number;
  total_tool_calls: number;
  tools: TelemetryToolCall[];
  answer_preview: string;
  model: string;
}

function ensureDreamsDir(): void {
  if (!fs.existsSync(DREAMS_DIR)) {
    fs.mkdirSync(DREAMS_DIR, { recursive: true });
  }
}

/** Load existing dream file for an agent */
export function loadDreamFile(agentName: string): string {
  const filePath = resolve(DREAMS_DIR, `${agentName}.md`);
  if (!fs.existsSync(filePath)) return '';
  return fs.readFileSync(filePath, 'utf-8');
}

/** Write dream content for an agent */
function writeDreamFile(agentName: string, content: string): void {
  ensureDreamsDir();
  const filePath = resolve(DREAMS_DIR, `${agentName}.md`);
  fs.mkdirSync(dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content.slice(0, MAX_DREAM_LENGTH), 'utf-8');
}

/** Query telemetry_turn rows for a given date range and agent */
function queryTelemetry(agentId: string, dateStr: string): DreamTurnSummary[] {
  const db = getDb();
  const dayStart = new Date(`${dateStr}T00:00:00+08:00`).getTime();
  const dayEnd = new Date(`${dateStr}T23:59:59+08:00`).getTime();

  const rows = db.prepare(`
    SELECT agent_id, channel, loop_rounds, total_tool_calls,
           tools_json, answer_preview, model
    FROM telemetry_turn
    WHERE agent_id = ? AND started_at >= ? AND started_at <= ?
    ORDER BY started_at
  `).all(agentId, dayStart, dayEnd) as Array<{
    agent_id: string;
    channel: string;
    loop_rounds: number;
    total_tool_calls: number;
    tools_json: string;
    answer_preview: string;
    model: string;
  }>;

  return rows.map(r => ({
    agent_id: r.agent_id,
    channel: r.channel,
    loop_rounds: r.loop_rounds,
    total_tool_calls: r.total_tool_calls,
    tools: JSON.parse(r.tools_json || '[]'),
    answer_preview: r.answer_preview,
    model: r.model,
  }));
}

/** Build a structured summary of tool usage patterns from raw turns */
function buildToolUsageSummary(turns: DreamTurnSummary[]): string {
  if (turns.length === 0) return '';

  const toolFreq = new Map<string, { calls: number; failures: number; totalMs: number }>();
  let highLoopTurns = 0;
  const errorPatterns: string[] = [];

  for (const turn of turns) {
    if (turn.loop_rounds > 5) highLoopTurns++;

    for (const tool of turn.tools) {
      const entry = toolFreq.get(tool.name) ?? { calls: 0, failures: 0, totalMs: 0 };
      entry.calls++;
      entry.totalMs += tool.duration_ms;
      if (!tool.success) {
        entry.failures++;
        if (tool.error) errorPatterns.push(`${tool.name}: ${tool.error.slice(0, 120)}`);
      }
      toolFreq.set(tool.name, entry);
    }
  }

  const lines: string[] = [];
  lines.push(`总交互次数: ${turns.length}, 高轮次(>5)交互: ${highLoopTurns}`);
  lines.push('');
  lines.push('工具调用统计:');
  const sorted = [...toolFreq.entries()].sort((a, b) => b[1].calls - a[1].calls);
  for (const [name, stat] of sorted.slice(0, 15)) {
    const avgMs = Math.round(stat.totalMs / stat.calls);
    lines.push(`- ${name}: ${stat.calls}次, 失败${stat.failures}次, 平均耗时${avgMs}ms`);
  }

  if (errorPatterns.length > 0) {
    lines.push('');
    lines.push('错误样例(最多10条):');
    for (const e of errorPatterns.slice(0, 10)) {
      lines.push(`- ${e}`);
    }
  }

  // Include a few high-loop-rounds turns with their tool chain for context
  const interestingTurns = turns
    .filter(t => t.loop_rounds > 5 || t.tools.some(tc => !tc.success))
    .slice(0, 3);

  if (interestingTurns.length > 0) {
    lines.push('');
    lines.push('典型探索性交互:');
    for (const t of interestingTurns) {
      const chain = t.tools.map(tc => `${tc.name}${tc.success ? '' : '(FAIL)'}`).join(' → ');
      lines.push(`- [${t.loop_rounds}轮] ${chain}`);
      if (t.answer_preview) {
        lines.push(`  结果摘要: ${t.answer_preview.slice(0, 100)}`);
      }
    }
  }

  return lines.join('\n');
}

const DREAM_SYSTEM_PROMPT = `你是一个 AI 系统的"梦境分析器"。你的任务是根据今天 agent 的工具调用遥测数据，总结出有价值的工具使用经验教训。

输出要求：
- 使用中文
- markdown 格式，以 "## 工具使用经验" 开头
- 按工具名分小节（### tool_name）
- 每条经验简洁（一行）、可操作
- 重点关注：失败后的正确做法、高效的 tool chain 组合、避坑指南
- 如果旧经验仍然有效则保留，过时或重复的经验可合并/删除
- 总字数控制在 2000 字以内`;

/** Run dream analysis for a single agent */
export async function runDreamForAgent(agentId: string, agentName: string, dateStr: string): Promise<boolean> {
  const turns = queryTelemetry(agentId, dateStr);
  if (turns.length === 0) {
    log.file(`[dream] ${agentName}: 无数据，跳过`);
    return false;
  }

  const summary = buildToolUsageSummary(turns);
  const existingDream = loadDreamFile(agentName);

  const userMessage = [
    `今日日期: ${dateStr}`,
    `Agent: ${agentName}`,
    '',
    '--- 今日工具使用数据 ---',
    summary,
    '',
    existingDream ? `--- 现有经验（请合并更新） ---\n${existingDream}` : '（暂无历史经验，请从头总结）',
  ].join('\n');

  try {
    const provider = getProvider();
    const model = getModelName();

    const result = await provider.createMessage({
      model,
      max_tokens: 2000,
      system: DREAM_SYSTEM_PROMPT,
      tools: [],
      messages: [{ role: 'user', content: userMessage }],
    });

    const textBlocks = result.content.filter(b => b.type === 'text');
    const dreamText = textBlocks.map(b => (b as any).text).join('\n').trim();

    if (dreamText) {
      writeDreamFile(agentName, dreamText);
      log.file(`[dream] ${agentName}: 已生成 dream (${dreamText.length} 字符)`);
      return true;
    }
  } catch (err: any) {
    log.error(`[dream] ${agentName}: LLM 调用失败: ${err.message}`);
  }

  return false;
}

/** Run dream for all agents with telemetry data on a given date */
export async function runDreamForAll(dateStr: string): Promise<void> {
  const agents = getAllAgents();
  log.file(`[dream] 开始每日回顾: ${dateStr}, ${agents.length} 个 agent`);

  for (const agent of agents) {
    await runDreamForAgent(agent.id, agent.name, dateStr);
  }

  log.file(`[dream] 每日回顾完成: ${dateStr}`);
}
